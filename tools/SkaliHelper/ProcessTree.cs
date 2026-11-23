using System.Globalization;
using System.Runtime.InteropServices;
using static SkaliHelper.Native;

namespace SkaliHelper;

/// <summary>Process handles, creation times and descendant lookup (Toolhelp32 snapshot) shared by stats and kill.</summary>
internal static class ProcessTree
{
    /// <summary>What we could find out about a pid.</summary>
    public enum State
    {
        /// <summary>No such process (or it has exited).</summary>
        Dead,
        /// <summary>Alive, opened with the requested access.</summary>
        Alive,
        /// <summary>Alive, but only opened with PROCESS_QUERY_LIMITED_INFORMATION (the requested access was denied).</summary>
        Limited,
        /// <summary>It exists, but we may not open it at all. Must never be treated as dead.</summary>
        Denied,
    }

    /// <summary>
    /// Opens <paramref name="pid"/>. Only a pid that doesn't exist (or has exited) is <see cref="State.Dead"/>:
    /// access denied means someone else's live process, and reading that as dead could launch a second copy of a game
    /// on the same world. The handle is non-zero for Alive and Limited; the caller closes it.
    /// </summary>
    public static (State State, IntPtr Handle) Open(int pid, uint access)
    {
        var h = OpenProcess(access | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h != IntPtr.Zero)
        {
            if (WaitForSingleObject(h, 0) == WAIT_TIMEOUT) return (State.Alive, h);
            CloseHandle(h); // exited, only kept around by someone's handle
            return (State.Dead, IntPtr.Zero);
        }
        if (Marshal.GetLastPInvokeError() == ERROR_INVALID_PARAMETER) return (State.Dead, IntPtr.Zero);

        // Denied (or another failure): the process exists. See whether we can at least query it.
        h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero)
            return Marshal.GetLastPInvokeError() == ERROR_INVALID_PARAMETER ? (State.Dead, IntPtr.Zero) : (State.Denied, IntPtr.Zero);
        // No SYNCHRONIZE here, so use the exit code. A process that exited with 259 reads as alive: the safe side.
        if (!GetExitCodeProcess(h, out var code) || code == STILL_ACTIVE) return (State.Limited, h);
        CloseHandle(h);
        return (State.Dead, IntPtr.Zero);
    }

    /// <summary>
    /// Opens a live process with <paramref name="access"/>, or returns IntPtr.Zero if it's dead or can't be opened
    /// that way. Only for best-effort work on descendants; use <see cref="Open"/> for the process the caller named.
    /// </summary>
    public static IntPtr OpenAlive(int pid, uint access)
    {
        var (state, h) = Open(pid, access);
        if (state == State.Alive) return h;
        if (state == State.Limited && (access & ~PROCESS_QUERY_LIMITED_INFORMATION) == 0) return h;
        if (h != IntPtr.Zero) CloseHandle(h);
        return IntPtr.Zero;
    }

    /// <summary>
    /// Throws unless the process behind <paramref name="h"/> was created at <paramref name="startTime"/> (the format
    /// launch/stats return). No-op when <paramref name="startTime"/> is null. Guards against a recycled pid.
    /// </summary>
    public static void CheckIdentity(int pid, IntPtr h, string? startTime)
    {
        if (startTime is null) return;
        var created = CreationTime(h);
        if (created == 0 || FormatTime(created) != startTime) throw new HelperException($"pid {pid} is a different process");
    }

    public static long CreationTime(IntPtr h) => GetProcessTimes(h, out var created, out _, out _, out _) ? created : 0;

    public static string FormatTime(long fileTime) =>
        DateTime.FromFileTimeUtc(fileTime).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    /// <summary>
    /// The root followed by all its live descendants. A child only counts if it was created after its parent,
    /// so a recycled parent pid doesn't adopt unrelated processes.
    /// </summary>
    public static List<int> WithDescendants(int root, long rootCreated)
    {
        var children = new Dictionary<int, List<int>>();
        foreach (var (pid, parent) in Snapshot())
        {
            if (pid == parent) continue;
            if (!children.TryGetValue(parent, out var list)) children[parent] = list = [];
            list.Add(pid);
        }

        var result = new List<int> { root };
        var queue = new Queue<(int Pid, long Created)>();
        queue.Enqueue((root, rootCreated));
        while (queue.Count > 0)
        {
            var (pid, created) = queue.Dequeue();
            if (!children.TryGetValue(pid, out var kids)) continue;
            foreach (var kid in kids)
            {
                if (result.Contains(kid)) continue;
                var h = OpenAlive(kid, 0);
                if (h == IntPtr.Zero) continue;
                var kidCreated = CreationTime(h);
                CloseHandle(h);
                if (kidCreated < created) continue;
                result.Add(kid);
                queue.Enqueue((kid, kidCreated));
            }
        }
        return result;
    }

    private static List<(int Pid, int Parent)> Snapshot()
    {
        var snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == INVALID_HANDLE_VALUE) throw new HelperException("CreateToolhelp32Snapshot failed: " + Marshal.GetLastPInvokeErrorMessage());
        try
        {
            var list = new List<(int, int)>();
            var entry = new PROCESSENTRY32 { dwSize = Marshal.SizeOf<PROCESSENTRY32>() };
            for (var ok = Process32FirstW(snap, ref entry); ok; ok = Process32NextW(snap, ref entry))
                list.Add((entry.th32ProcessID, entry.th32ParentProcessID));
            return list;
        }
        finally
        {
            CloseHandle(snap);
        }
    }
}
