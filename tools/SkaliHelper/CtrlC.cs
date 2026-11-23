using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using static SkaliHelper.Native;

namespace SkaliHelper;

/// <summary>
/// <c>ctrlc</c>: delivers CTRL_C_EVENT to every process on the target's console (so games save and exit).
/// With <c>startTime</c>, refuses a pid that now belongs to a different process.
/// </summary>
internal static class CtrlC
{
    public static JsonNode Run(JsonNode request)
    {
        var pid = request["pid"]?.GetValue<int>() ?? throw new HelperException("pid is required");
        var startTime = request["startTime"]?.GetValue<string>();
        Users.EnablePrivileges("SeDebugPrivilege"); // best effort: lets SYSTEM / an admin open SkaliGames processes

        // Held open until the event is sent, so the pid can't be recycled between the check and the attach.
        var h = IntPtr.Zero;
        if (startTime is not null)
        {
            ProcessTree.State state;
            (state, h) = ProcessTree.Open(pid, 0);
            if (state == ProcessTree.State.Dead) throw new HelperException($"pid {pid} is not running");
            if (state == ProcessTree.State.Denied) throw new HelperException($"cannot verify pid {pid}: access denied");
        }
        try
        {
            ProcessTree.CheckIdentity(pid, h, startTime);
            Send(pid);
        }
        finally
        {
            if (h != IntPtr.Zero) CloseHandle(h);
        }
        return new JsonObject { ["sent"] = true };
    }

    private static void Send(int pid)
    {
        FreeConsole();
        if (!AttachConsole(pid))
            throw new HelperException($"AttachConsole({pid}) failed: {Marshal.GetLastPInvokeErrorMessage()}");
        try
        {
            // Ignore the event ourselves: we share the console now.
            SetConsoleCtrlHandler(IntPtr.Zero, true);
            if (!GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0))
                throw new HelperException("GenerateConsoleCtrlEvent failed: " + Marshal.GetLastPInvokeErrorMessage());
            Thread.Sleep(200); // let the event be dispatched before we leave the console
        }
        finally
        {
            FreeConsole();
        }
    }
}
