using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using static SkaliHelper.Native;

namespace SkaliHelper;

/// <summary><c>ctrlc</c>: delivers CTRL_C_EVENT to every process on the target's console (so games save and exit).</summary>
internal static class CtrlC
{
    public static JsonNode Run(JsonNode request)
    {
        var pid = request["pid"]?.GetValue<int>() ?? throw new HelperException("pid is required");
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
        return new JsonObject { ["sent"] = true };
    }
}
