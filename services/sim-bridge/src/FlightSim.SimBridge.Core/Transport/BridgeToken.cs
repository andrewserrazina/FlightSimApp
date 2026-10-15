using System.Security.Cryptography;
using System.Text;

namespace FlightSim.SimBridge.Transport;

/// <summary>
/// Per-bridge-process shared secret. The desktop shell generates it, hands it to the bridge over
/// stdin (never argv, which other local processes can read), and presents it in the client hello.
/// </summary>
public sealed class BridgeToken
{
    /// <summary>32 random bytes, base64url without padding = 43 characters.</summary>
    public const int MinLength = 43;
    public const int MaxLength = 128;
    private readonly byte[] _bytes;

    private BridgeToken(string value) => _bytes = Encoding.UTF8.GetBytes(value);

    public static BridgeToken Parse(string? value)
    {
        value = value?.Trim();
        if (value is null || value.Length < MinLength || value.Length > MaxLength || !value.All(IsTokenChar))
        {
            throw new FormatException($"Bridge token must be {MinLength}-{MaxLength} base64url characters.");
        }
        return new BridgeToken(value);
    }

    public static string Generate() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>Constant-time comparison so response timing does not leak token prefixes.</summary>
    public bool Matches(string? candidate)
    {
        if (candidate is null) return false;
        var candidateBytes = Encoding.UTF8.GetBytes(candidate);
        return CryptographicOperations.FixedTimeEquals(candidateBytes, _bytes);
    }

    public override string ToString() => "<redacted>";

    private static bool IsTokenChar(char c) => char.IsAsciiLetterOrDigit(c) || c is '-' or '_';
}
