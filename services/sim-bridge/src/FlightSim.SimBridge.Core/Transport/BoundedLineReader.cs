using System.Text;

namespace FlightSim.SimBridge.Transport;

public sealed class LineTooLongException(int limit) : IOException($"Line exceeds {limit} bytes.");

/// <summary>Reads '\n'-terminated UTF-8 lines with a hard size cap, so a hostile peer cannot exhaust memory.</summary>
internal sealed class BoundedLineReader(Stream stream, int maxLineBytes)
{
    private readonly byte[] _buffer = new byte[4096];
    private readonly MemoryStream _line = new();
    private int _start;
    private int _end;

    /// <returns>The next line without its terminator, or null at end of stream.</returns>
    public async Task<string?> ReadLineAsync(CancellationToken cancellationToken)
    {
        _line.SetLength(0);
        while (true)
        {
            if (_start == _end)
            {
                _start = 0;
                _end = await stream.ReadAsync(_buffer, cancellationToken).ConfigureAwait(false);
                if (_end == 0)
                {
                    return _line.Length > 0 ? Decode() : null;
                }
            }

            var newline = Array.IndexOf(_buffer, (byte)'\n', _start, _end - _start);
            var take = (newline >= 0 ? newline : _end) - _start;
            if (_line.Length + take > maxLineBytes) throw new LineTooLongException(maxLineBytes);
            _line.Write(_buffer, _start, take);
            if (newline >= 0)
            {
                _start = newline + 1;
                return Decode();
            }
            _start = _end;
        }
    }

    private string Decode()
    {
        var text = Encoding.UTF8.GetString(_line.GetBuffer(), 0, (int)_line.Length);
        return text.EndsWith('\r') ? text[..^1] : text;
    }
}
