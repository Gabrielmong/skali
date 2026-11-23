using System.Collections;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using static SkaliHelper.Native;

namespace SkaliHelper;

/// <summary>
/// <c>launch</c>: starts a game detached from us (own hidden console, outside our job) with stdout+stderr appended
/// to a log file, so it outlives the helper and the Node service. With <c>user</c>, the game runs as that local user
/// (logged on for batch work, own profile and environment, its own non-interactive window station and desktop).
/// </summary>
internal static unsafe class Launch
{
    public static JsonNode Run(JsonNode request)
    {
        var exe = Required(request, "exe");
        var cwd = Required(request, "cwd");
        var stdoutPath = Required(request, "stdoutPath");
        var args = request["args"]?.AsArray().Select(a => a!.GetValue<string>()).ToList() ?? [];
        var env = request["env"]?.AsObject().ToDictionary(kv => kv.Key, kv => kv.Value!.GetValue<string>()) ?? [];
        var user = request["user"];

        IntPtr token = IntPtr.Zero, profile = IntPtr.Zero;
        Dictionary<string, string> baseEnv;
        if (user is null)
        {
            baseEnv = CurrentEnvironment();
        }
        else
        {
            var name = Required(user, "name");
            var password = user["password"]?.GetValue<string>() ?? throw new HelperException("user.password is required");
            (token, profile, baseEnv) = Users.LogonForLaunch(name, password);
        }
        try
        {
            return Run(exe, args, cwd, stdoutPath, EnvironmentBlock(baseEnv, env), token);
        }
        catch
        {
            // Nothing was started, so nothing needs the profile (see LogonForLaunch).
            if (token != IntPtr.Zero) Users.UnloadProfile(token, profile);
            throw;
        }
        finally
        {
            if (token != IntPtr.Zero) CloseHandle(token);
        }
    }

    private static JsonNode Run(string exe, List<string> args, string cwd, string stdoutPath, string envBlock, IntPtr token)
    {
        var log = OpenInheritable(stdoutPath, FILE_APPEND_DATA, OPEN_ALWAYS);
        try
        {
            var nul = OpenInheritable("NUL", GENERIC_READ, OPEN_EXISTING);
            try
            {
                var (pid, created) = Start(exe, args, cwd, envBlock, token, stdin: nul, output: log);
                return new JsonObject { ["pid"] = pid, ["startTime"] = ProcessTree.FormatTime(created) };
            }
            finally
            {
                CloseHandle(nul);
            }
        }
        finally
        {
            CloseHandle(log);
        }
    }

    private static string Required(JsonNode request, string name) =>
        request[name]?.GetValue<string>() is { Length: > 0 } s ? s : throw new HelperException($"{name} is required");

    private static IntPtr OpenInheritable(string path, uint access, uint disposition)
    {
        var sa = new SECURITY_ATTRIBUTES { nLength = sizeof(SECURITY_ATTRIBUTES), bInheritHandle = 1 };
        var h = CreateFileW(path, access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, ref sa, disposition, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (h == INVALID_HANDLE_VALUE) throw new HelperException($"cannot open {path}: {Marshal.GetLastPInvokeErrorMessage()}");
        return h;
    }

    private static Dictionary<string, string> CurrentEnvironment()
    {
        var vars = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry e in Environment.GetEnvironmentVariables()) vars[(string)e.Key] = (string?)e.Value ?? "";
        return vars;
    }

    /// <summary><paramref name="vars"/> with <paramref name="overrides"/> applied, as a sorted UTF-16 environment block.</summary>
    private static string EnvironmentBlock(Dictionary<string, string> vars, Dictionary<string, string> overrides)
    {
        foreach (var (k, v) in overrides)
        {
            vars.Remove(k); // so the override's spelling of the name wins
            vars[k] = v;
        }
        var sb = new StringBuilder();
        foreach (var (k, v) in vars.OrderBy(kv => kv.Key, StringComparer.OrdinalIgnoreCase)) sb.Append(k).Append('=').Append(v).Append('\0');
        return sb.Append('\0').ToString();
    }

    private static (int Pid, long Created) Start(string exe, List<string> args, string cwd, string envBlock, IntPtr token, IntPtr stdin, IntPtr output)
    {
        // Only these handles are inherited; anything else inheritable in this process (e.g. the pipes Node gave us)
        // must not leak into the game, or Node would wait on our stdout until the game exits.
        var handles = stackalloc IntPtr[] { stdin, output };
        var size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        var attrs = Marshal.AllocHGlobal(size);
        try
        {
            if (!InitializeProcThreadAttributeList(attrs, 1, 0, ref size))
                throw new HelperException("InitializeProcThreadAttributeList failed: " + Marshal.GetLastPInvokeErrorMessage());
            try
            {
                if (!UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, (IntPtr)handles, 2 * IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                    throw new HelperException("UpdateProcThreadAttribute failed: " + Marshal.GetLastPInvokeErrorMessage());

                var si = new STARTUPINFOEX
                {
                    StartupInfo = new STARTUPINFO
                    {
                        cb = sizeof(STARTUPINFOEX),
                        dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW,
                        wShowWindow = SW_HIDE,
                        hStdInput = stdin,
                        hStdOutput = output,
                        hStdError = output,
                    },
                    lpAttributeList = attrs,
                };
                // Never CREATE_NEW_PROCESS_GROUP: it disables Ctrl+C in the game, and we need Ctrl+C for a clean save.
                var flags = CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
                var commandLine = (CommandLine.Join(exe, args) + '\0').ToCharArray();
                // Node spawns us detached, i.e. with CREATE_NEW_PROCESS_GROUP, which sets "ignore Ctrl+C" on us and
                // every process we create. Clear it so the game inherits a working Ctrl+C.
                SetConsoleCtrlHandler(IntPtr.Zero, false);

                PROCESS_INFORMATION pi;
                bool ok;
                string api;
                fixed (char* cmd = commandLine)
                fixed (char* envPtr = envBlock)
                fixed (char* noDesktop = "")
                {
                    if (token == IntPtr.Zero)
                    {
                        api = "CreateProcess";
                        ok = CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, true, flags | CREATE_BREAKAWAY_FROM_JOB, envPtr, cwd, ref si, out pi);
                        // Our job may forbid breakaway; then the game stays in it (best effort).
                        if (!ok && Marshal.GetLastPInvokeError() == ERROR_ACCESS_DENIED)
                            ok = CreateProcessW(exe, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, envPtr, cwd, ref si, out pi);
                    }
                    else
                    {
                        // "" (not NULL): don't inherit our desktop; the system gives the user's logon session its own
                        // non-interactive window station + desktop (Service-0x0-<luid>$\Default), so no ACL grants needed.
                        si.StartupInfo.lpDesktop = (IntPtr)noDesktop;
                        api = "CreateProcessAsUser";
                        // LocalSystem holds these (disabled); an elevated admin lacks SeAssignPrimaryToken.
                        Users.EnablePrivileges("SeAssignPrimaryTokenPrivilege", "SeIncreaseQuotaPrivilege");
                        ok = CreateProcessAsUserW(token, exe, cmd, IntPtr.Zero, IntPtr.Zero, true, flags | CREATE_BREAKAWAY_FROM_JOB, envPtr, cwd, ref si, out pi);
                        var err = ok ? 0 : Marshal.GetLastPInvokeError();
                        if (err == ERROR_ACCESS_DENIED)
                        {
                            ok = CreateProcessAsUserW(token, exe, cmd, IntPtr.Zero, IntPtr.Zero, true, flags, envPtr, cwd, ref si, out pi);
                            err = ok ? 0 : Marshal.GetLastPInvokeError();
                        }
                        // Fail closed: no weaker fallback (e.g. CreateProcessWithTokenW, which drops the handle list and
                        // may put the game on the interactive desktop).
                        if (err == ERROR_PRIVILEGE_NOT_HELD)
                            throw new HelperException("user launch requires LocalSystem (SeAssignPrimaryTokenPrivilege not held)");
                    }
                }
                if (!ok) throw new HelperException($"{api} failed for {exe}: {Marshal.GetLastPInvokeErrorMessage()}");

                try
                {
                    return (pi.dwProcessId, ProcessTree.CreationTime(pi.hProcess));
                }
                finally
                {
                    CloseHandle(pi.hThread);
                    CloseHandle(pi.hProcess);
                }
            }
            finally
            {
                DeleteProcThreadAttributeList(attrs);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(attrs);
        }
    }
}
