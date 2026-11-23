using System.Globalization;
using System.Runtime.InteropServices;
using static SkaliHelper.Native;

namespace SkaliHelper;

/// <summary>Process handles, creation times and descendant lookup (Toolhelp32 snapshot) shared by stats and kill.</summary>
internal static class ProcessTree
{
    /// <summary>Opens a live process, or returns IntPtr.Zero if it doesn't exist / has exited / can't be opened.</summary>
    public static IntPtr OpenAlive(int pid, uint access)
    {
        var h = OpenProcess(access | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return IntPtr.Zero;
        if (WaitForSingleObject(h, 0) == WAIT_TIMEOUT) return h;
        CloseHandle(h); // exited, only kept around by someone's handle
        return IntPtr.Zero;
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
