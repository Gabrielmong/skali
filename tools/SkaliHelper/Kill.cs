using System.Text.Json.Nodes;
using static SkaliHelper.Native;

namespace SkaliHelper;

/// <summary><c>kill</c>: terminates a process and all its descendants.</summary>
internal static class Kill
{
    public static JsonNode Run(JsonNode request)
    {
        var pid = request["pid"]?.GetValue<int>() ?? throw new HelperException("pid is required");
        var h = ProcessTree.OpenAlive(pid, PROCESS_TERMINATE);
        if (h == IntPtr.Zero) return new JsonObject { ["killed"] = false };

        bool killed;
        try
        {
            var tree = ProcessTree.WithDescendants(pid, ProcessTree.CreationTime(h));
            // Root first so it can't spawn replacements for the children we're about to kill.
            killed = TerminateProcess(h, 1);
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
