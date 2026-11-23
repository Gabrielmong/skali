using System.Text;

namespace SkaliHelper;

/// <summary>Builds a Windows command line that MSVCRT / CommandLineToArgvW parse back into the same argv.</summary>
internal static class CommandLine
{
    public static string Join(string exe, IEnumerable<string> args)
    {
        // argv[0] is parsed without backslash escapes; a path can't contain quotes, so just quote it.
        var sb = new StringBuilder().Append('"').Append(exe).Append('"');
        foreach (var arg in args)
        {
            sb.Append(' ');
            AppendArg(sb, arg);
        }
        return sb.ToString();
    }

    private static void AppendArg(StringBuilder sb, string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny([' ', '\t', '\n', '\v', '"']) < 0)
        {
            sb.Append(arg);
            return;
        }

        sb.Append('"');
        var backslashes = 0;
        foreach (var c in arg)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            if (c == '"')
            {
                // Backslashes before a quote are doubled, plus one to escape the quote itself.
                sb.Append('\\', backslashes * 2 + 1).Append('"');
            }
            else
            {
                sb.Append('\\', backslashes).Append(c);
            }
            backslashes = 0;
        }
        // Backslashes before the closing quote are doubled so they don't escape it.
        sb.Append('\\', backslashes * 2).Append('"');
    }
}
