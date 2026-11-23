using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using static SkaliHelper.Native;

namespace SkaliHelper;

/// <summary>
/// The low-privilege local user games run as: <c>ensure-user</c> (create / reset password / grant logon rights),
/// <c>delete-user</c> (test cleanup), and logging it on for <c>launch</c>.
/// </summary>
internal static partial class Users
{
    /// <summary>Batch logon allowed (what launch uses); every other kind of logon denied.</summary>
    private static readonly string[] Rights =
    [
        "SeBatchLogonRight",
        "SeDenyInteractiveLogonRight",
        "SeDenyRemoteInteractiveLogonRight",
        "SeDenyNetworkLogonRight",
    ];

    private const int Flags = UF_SCRIPT | UF_DONT_EXPIRE_PASSWD | UF_PASSWD_CANT_CHANGE;

    [GeneratedRegex("^[A-Za-z0-9_.-]{1,20}$")]
    private static partial Regex ValidName();

    private static string Name(JsonNode request) =>
        request["name"]?.GetValue<string>() is { } n && ValidName().IsMatch(n) ? n : throw new HelperException("name must match ^[A-Za-z0-9_.-]{1,20}$");

    /// <summary><c>ensure-user</c>: <c>{ name }</c> → <c>{ created, password }</c>. Always sets a new password.</summary>
    public static JsonNode Ensure(JsonNode request)
    {
        var name = Name(request);
        var password = NewPassword();

        var info = new USER_INFO_1
        {
            usri1_name = name,
            usri1_password = password,
            usri1_priv = USER_PRIV_USER, // member of Users only
            usri1_flags = Flags,
            usri1_comment = "Runs Skali game servers",
        };
        var rc = NetUserAdd(null, 1, ref info, out _);
        var created = rc == NERR_Success;
        if (!created && rc != NERR_UserExists) throw NetError($"NetUserAdd({name})", rc);

        // An existing account must not have been put in another group (e.g. Administrators): games would run with it.
        CheckOnlyUsersGroup(name);

        if (!created)
        {
            // Re-assert the flags (also clears disabled / locked out: Skáli owns this account) and reset the password.
            var flags = new USER_INFO_1008 { usri1008_flags = Flags };
            rc = NetUserSetInfo(null, name, 1008, ref flags, out _);
            if (rc != NERR_Success) throw NetError($"NetUserSetInfo({name}, flags)", rc);
            var pw = new USER_INFO_1003 { usri1003_password = password };
            rc = NetUserSetInfo(null, name, 1003, ref pw, out _);
            if (rc != NERR_Success) throw NetError($"NetUserSetInfo({name}, password)", rc);
        }

        WithPolicy(policy => WithRights(Rights, rights =>
        {
            var status = LsaAddAccountRights(policy, Sid(name), rights, rights.Length);
            if (status != 0) throw LsaError($"LsaAddAccountRights({name})", status);
        }));

        return new JsonObject { ["created"] = created, ["password"] = password };
    }

    /// <summary>
    /// <c>delete-user</c>: <c>{ name }</c> → <c>{ deleted }</c>. Removes the user's rights, the account and (best effort)
    /// its profile. Test cleanup only: restricted to SkaliGamesTest* user accounts, so it can never remove the real
    /// SkaliGames account, a person's account or a group.
    /// </summary>
    public static JsonNode Delete(JsonNode request)
    {
        var name = Name(request);
        if (!name.StartsWith("SkaliGamesTest", StringComparison.OrdinalIgnoreCase))
            throw new HelperException("delete-user only deletes SkaliGamesTest* users");

        var found = LookupLocal(name);
        if (found is null) return new JsonObject { ["deleted"] = false };
        var (sid, use) = found.Value;
        if (use != SidTypeUser) throw new HelperException($"{name} is not a user account");

        WithPolicy(policy =>
        {
            var status = LsaRemoveAccountRights(policy, sid, true, null, 0);
            if (status != 0 && status != STATUS_OBJECT_NAME_NOT_FOUND) throw LsaError($"LsaRemoveAccountRights({name})", status);
        });
        var rc = NetUserDel(null, name);
        if (rc != NERR_Success && rc != NERR_UserNotFound) throw NetError($"NetUserDel({name})", rc);
        // Fails while the profile is still loaded (a successful launch never unloads it); leftovers are harmless.
        DeleteProfileW(new SecurityIdentifier(sid, 0).Value, null, null);
        return new JsonObject { ["deleted"] = rc == NERR_Success };
    }

    /// <summary>
    /// Logs the user on for batch work, loads its profile (games keep saves under AppData) and returns its primary
    /// token and its own environment. The caller closes the token.
    /// </summary>
    /// <remarks>
    /// The profile is deliberately left loaded once the game is created: we exit right after the launch, and unloading
    /// would leave the game with HKCU mapped to .DEFAULT. If the launch fails, the caller unloads it with
    /// <see cref="UnloadProfile"/>.
    /// </remarks>
    public static (IntPtr Token, IntPtr Profile, Dictionary<string, string> Env) LogonForLaunch(string name, string password)
    {
        if (!LogonUserW(name, ".", password, LOGON32_LOGON_BATCH, LOGON32_PROVIDER_DEFAULT, out var token))
            throw new HelperException($"LogonUser({name}) failed: {Marshal.GetLastPInvokeErrorMessage()}");
        try
        {
            EnablePrivileges("SeBackupPrivilege", "SeRestorePrivilege"); // LoadUserProfile needs them
            var profile = new PROFILEINFO { dwSize = Marshal.SizeOf<PROFILEINFO>(), dwFlags = PI_NOUI, lpUserName = name };
            if (!LoadUserProfileW(token, ref profile))
                throw new HelperException($"LoadUserProfile({name}) failed: {Marshal.GetLastPInvokeErrorMessage()}");
            try
            {
                if (!CreateEnvironmentBlock(out var block, token, false))
                    throw new HelperException($"CreateEnvironmentBlock({name}) failed: {Marshal.GetLastPInvokeErrorMessage()}");
                try
                {
                    return (token, profile.hProfile, ParseEnvironmentBlock(block));
                }
                finally
                {
                    DestroyEnvironmentBlock(block);
                }
            }
            catch
            {
                UnloadUserProfile(token, profile.hProfile);
                throw;
            }
        }
        catch
        {
            CloseHandle(token);
            throw;
        }
    }

    /// <summary>Undoes <see cref="LogonForLaunch"/>'s LoadUserProfile after a failed launch.</summary>
    public static void UnloadProfile(IntPtr token, IntPtr profile) => UnloadUserProfile(token, profile);

    /// <summary>Best effort: enables privileges our token holds (LocalSystem holds all of these, disabled).</summary>
    public static void EnablePrivileges(params string[] names)
    {
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, out var token)) return;
        try
        {
            foreach (var name in names)
            {
                if (!LookupPrivilegeValueW(null, name, out var luid)) continue;
                var tp = new TOKEN_PRIVILEGES
                {
                    PrivilegeCount = 1,
                    Privilege = new LUID_AND_ATTRIBUTES { Luid = luid, Attributes = SE_PRIVILEGE_ENABLED },
                };
                AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
            }
        }
        finally
        {
            CloseHandle(token);
        }
    }

    private static Dictionary<string, string> ParseEnvironmentBlock(IntPtr block)
    {
        var vars = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var p = block; ;)
        {
            var entry = Marshal.PtrToStringUni(p);
            if (string.IsNullOrEmpty(entry)) break;
            p += (entry.Length + 1) * 2;
            var eq = entry.IndexOf('=', 1); // names like "=C:" start with '='
            if (eq > 0) vars[entry[..eq]] = entry[(eq + 1)..];
        }
        return vars;
    }

    private static string NewPassword()
    {
        const string upper = "ABCDEFGHJKLMNPQRSTUVWXYZ", lower = "abcdefghijkmnopqrstuvwxyz", digits = "23456789", symbols = "!#%+-.:=?@_~";
        for (;;)
        {
            var pw = RandomNumberGenerator.GetString(upper + lower + digits + symbols, 32);
            // Satisfy any complexity policy: all four classes present.
            if (pw.IndexOfAny(upper.ToCharArray()) >= 0 && pw.IndexOfAny(lower.ToCharArray()) >= 0 &&
                pw.IndexOfAny(digits.ToCharArray()) >= 0 && pw.IndexOfAny(symbols.ToCharArray()) >= 0)
                return pw;
        }
    }

    /// <summary>The local account's SID and type, or null when there is no such account.</summary>
    private static (byte[] Sid, int Use)? LookupLocal(string name)
    {
        var account = Environment.MachineName + "\\" + name;
        int sidSize = 0, domainSize = 0;
        LookupAccountNameW(null, account, null, ref sidSize, null, ref domainSize, out _);
        var err = Marshal.GetLastPInvokeError();
        if (err == ERROR_NONE_MAPPED) return null;
        if (sidSize == 0) throw new HelperException($"LookupAccountName({name}) failed: {new Win32Exception(err).Message}");
        var sid = new byte[sidSize];
        var domain = new char[domainSize];
        if (!LookupAccountNameW(null, account, sid, ref sidSize, domain, ref domainSize, out var use))
            throw new HelperException($"LookupAccountName({name}) failed: {Marshal.GetLastPInvokeErrorMessage()}");
        return (sid, use);
    }

    private static byte[] Sid(string name)
    {
        var sid = (SecurityIdentifier)new NTAccount(Environment.MachineName, name).Translate(typeof(SecurityIdentifier));
        var bytes = new byte[sid.BinaryLength];
        sid.GetBinaryForm(bytes, 0);
        return bytes;
    }

    private static void CheckOnlyUsersGroup(string name)
    {
        // Group names are localized ("Usuarios"), so resolve Users from its well-known SID.
        var users = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null).Translate(typeof(NTAccount)).Value;
        users = users[(users.LastIndexOf('\\') + 1)..];

        var rc = NetUserGetLocalGroups(null, name, 0, 0, out var buf, MAX_PREFERRED_LENGTH, out var read, out _);
        if (rc != NERR_Success) throw NetError($"NetUserGetLocalGroups({name})", rc);
        var others = new List<string>();
        try
        {
            for (var i = 0; i < read; i++)
            {
                var group = Marshal.PtrToStringUni(Marshal.ReadIntPtr(buf, i * IntPtr.Size)) ?? "";
                if (!group.Equals(users, StringComparison.OrdinalIgnoreCase)) others.Add(group);
            }
        }
        finally
        {
            NetApiBufferFree(buf);
        }
        if (others.Count > 0)
            throw new HelperException($"user {name} is a member of {string.Join(", ", others)}; refusing to run games as it (remove it from those groups)");
    }

    private static void WithPolicy(Action<IntPtr> action)
    {
        var attrs = new LSA_OBJECT_ATTRIBUTES { Length = Marshal.SizeOf<LSA_OBJECT_ATTRIBUTES>() };
        var status = LsaOpenPolicy(IntPtr.Zero, ref attrs, POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES, out var policy);
        if (status != 0) throw LsaError("LsaOpenPolicy", status);
        try
        {
            action(policy);
        }
        finally
        {
            LsaClose(policy);
        }
    }

    private static void WithRights(string[] names, Action<LSA_UNICODE_STRING[]> action)
    {
        var rights = names.Select(n => new LSA_UNICODE_STRING
        {
            Buffer = Marshal.StringToHGlobalUni(n),
            Length = (ushort)(n.Length * 2),
            MaximumLength = (ushort)((n.Length + 1) * 2),
        }).ToArray();
        try
        {
            action(rights);
        }
        finally
        {
            foreach (var r in rights) Marshal.FreeHGlobal(r.Buffer);
        }
    }

    private static HelperException NetError(string what, int rc) => new($"{what} failed: {NetMessage(rc)} ({rc})");

    private static string NetMessage(int rc) => rc switch
    {
        2245 => "the password does not meet the password policy",
        NERR_UserNotFound => "user not found",
        _ => new Win32Exception(rc).Message,
    };

    private static HelperException LsaError(string what, uint status) =>
        new($"{what} failed: {new Win32Exception(LsaNtStatusToWinError(status)).Message}");
}
