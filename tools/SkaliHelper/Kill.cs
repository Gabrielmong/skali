using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using static SkaliHelper.Native;

namespace SkaliHelper;

/// <summary>
/// <c>kill</c>: terminates a process and all its descendants. With <c>startTime</c>, refuses a pid that now belongs
/// to a different process. A process we may not terminate is an error, never reported as gone.
/// </summary>
internal static class Kill
{
    public static JsonNode Run(JsonNode request)
    {
        var pid = request["pid"]?.GetValue<int>() ?? throw new HelperException("pid is required");
        var startTime = request["startTime"]?.GetValue<string>();
        Users.EnablePrivileges("SeDebugPrivilege"); // best effort: lets SYSTEM / an admin open SkaliGames processes
        var (state, h) = ProcessTree.Open(pid, PROCESS_TERMINATE);
        switch (state)
        {
            case ProcessTree.State.Dead:
                return new JsonObject { ["killed"] = false };
            case ProcessTree.State.Denied:
                throw new HelperException($"cannot kill pid {pid}: access denied");
            case ProcessTree.State.Limited:
                try
                {
                    ProcessTree.CheckIdentity(pid, h, startTime);
                }
                finally
                {
                    CloseHandle(h);
                }
                throw new HelperException($"cannot kill pid {pid}: access denied");
        }

        bool killed;
        try
        {
            ProcessTree.CheckIdentity(pid, h, startTime);
            var tree = ProcessTree.WithDescendants(pid, ProcessTree.CreationTime(h));
            // Root first so it can't spawn replacements for the children we're about to kill.
            killed = TerminateProcess(h, 1);
            var error = killed ? "" : Marshal.GetLastPInvokeErrorMessage();
            // A process that refused to die is an error, never "already gone".
            if (!killed && WaitForSingleObject(h, 0) == WAIT_TIMEOUT) throw new HelperException($"cannot kill pid {pid}: {error}");
            foreach (var child in tree.Skip(1))
            {
                var ch = ProcessTree.OpenAlive(child, PROCESS_TERMINATE);
                if (ch == IntPtr.Zero) continue;
                TerminateProcess(ch, 1);
                CloseHandle(ch);
            }
        }
        finally
        {
            CloseHandle(h);
        }
        return new JsonObject { ["killed"] = killed };
    }
}
