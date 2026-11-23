// FakeGame: a stand-in dedicated game server for Skáli's integration tests.
//
//   --ready-after <s>   print READY after s seconds
//   --echo-args         print ARGS <json array of argv>
//   --echo-env <NAME>   print ENV <NAME>=<value>
//   --crash-after <s>   exit 1 after s seconds
//   --ignore-ctrlc      swallow Ctrl+C
//   --spawn-child       start a copy of itself with --idle and print CHILD <pid>
//   --print-utf8        print ÆØÅ ✓
//   --idle              print nothing, just wait (used for the spawned child)
// Default: TICK <n> every second. On Ctrl+C (unless ignored): SAVING, 500 ms, SAVED, exit 0.
using System.Diagnostics;
using System.Text;
using System.Text.Json;

// Always write UTF-8 (the console code page would mangle non-ASCII when redirected to a file).
var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
var gate = new object();
void Say(string line)
{
    lock (gate) stdout.WriteLine(line);
}

double? readyAfter = null, crashAfter = null;
string? echoEnv = null;
bool echoArgs = false, ignoreCtrlC = false, spawnChild = false, printUtf8 = false, idle = false;
for (var i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--ready-after" when i + 1 < args.Length: readyAfter = double.Parse(args[++i]); break;
        case "--crash-after" when i + 1 < args.Length: crashAfter = double.Parse(args[++i]); break;
        case "--echo-env" when i + 1 < args.Length: echoEnv = args[++i]; break;
        case "--echo-args": echoArgs = true; break;
        case "--ignore-ctrlc": ignoreCtrlC = true; break;
        case "--spawn-child": spawnChild = true; break;
        case "--print-utf8": printUtf8 = true; break;
        case "--idle": idle = true; break;
    }
}

Console.CancelKeyPress += (_, e) =>
{
    e.Cancel = true;
    if (ignoreCtrlC || idle) return;
    Say("SAVING");
    Thread.Sleep(500);
    Say("SAVED");
    Environment.Exit(0);
};

if (idle)
{
    Thread.Sleep(Timeout.Infinite);
    return;
}

if (echoArgs) Say("ARGS " + JsonSerializer.Serialize(args));
if (echoEnv != null) Say($"ENV {echoEnv}={Environment.GetEnvironmentVariable(echoEnv)}");
if (printUtf8) Say("ÆØÅ ✓");
if (spawnChild)
{
    var child = Process.Start(new ProcessStartInfo(Environment.ProcessPath!, "--idle") { UseShellExecute = false })!;
    Say($"CHILD {child.Id}");
}

if (readyAfter is { } r) _ = Task.Delay(TimeSpan.FromSeconds(r)).ContinueWith(_ => Say("READY"));
if (crashAfter is { } c) _ = Task.Delay(TimeSpan.FromSeconds(c)).ContinueWith(_ => Environment.Exit(1));

for (var n = 1; ; n++)
{
    Thread.Sleep(1000);
    Say($"TICK {n}");
}
