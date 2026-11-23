using System.Text;
using System.Text.Json.Nodes;
using SkaliHelper;

// SkaliHelper <verb>: JSON request on stdin, JSON response on stdout.
// Exit 0 on success; exit 1 with {"error": "..."} on failure.

// Grab stdout now: ctrlc attaches to another console, which must not redirect our response.
using var stdout = Console.OpenStandardOutput();
var utf8 = new UTF8Encoding(false);

int Respond(JsonNode response, int exitCode)
{
    var bytes = utf8.GetBytes(response.ToJsonString());
    stdout.Write(bytes);
    stdout.Flush();
    return exitCode;
}

try
{
    var verb = args.Length > 0 ? args[0] : throw new HelperException("usage: SkaliHelper <verb>");
    string input;
    using (var reader = new StreamReader(Console.OpenStandardInput(), utf8)) input = reader.ReadToEnd();
    var request = (string.IsNullOrWhiteSpace(input) ? null : JsonNode.Parse(input)) ?? new JsonObject();

    JsonNode response = verb switch
    {
        "launch" => Launch.Run(request),
        "stats" => Stats.Run(request),
        "ctrlc" => CtrlC.Run(request),
        "kill" => Kill.Run(request),
        "ensure-user" => Users.Ensure(request),
        "delete-user" => Users.Delete(request),
        _ => throw new HelperException($"unknown verb: {verb}"),
    };
    return Respond(response, 0);
}
catch (Exception e)
{
    return Respond(new JsonObject { ["error"] = e is HelperException ? e.Message : $"{e.GetType().Name}: {e.Message}" }, 1);
}

namespace SkaliHelper
{
    /// <summary>An expected failure whose message is returned to the caller as-is.</summary>
    internal sealed class HelperException(string message) : Exception(message);
}
