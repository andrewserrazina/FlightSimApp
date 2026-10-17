namespace FlightSim.SimBridge.Msfs.Gsx;

public enum GsxReceiptsFolderStatus
{
    Found,
    NotFound,
    AccessDenied,
    Error,
}

public sealed record GsxReceiptFile(string RelativePath, long Bytes, DateTime LastWriteUtc);

public sealed record GsxReceiptGroup(string Name, bool Documented, int FileCount, int HtmlCount, long Bytes, DateTime? OldestUtc, DateTime? NewestUtc, bool Truncated, string? Error, IReadOnlyList<GsxReceiptFile> Files);

public sealed record GsxReceiptsInventoryResult(string Root, GsxReceiptsFolderStatus Status, string? Error, IReadOnlyList<GsxReceiptGroup> Groups, IReadOnlyList<string> DocumentedGroupsMissing);

/// <summary>
/// Read-only discovery of GSX Pro 4.x invoice files (S2-05 slice B). It lists folder names and file
/// metadata (name, size, modification time) only: it never opens, reads, copies, renames, moves or
/// deletes a receipt, never follows links or junctions, and parses nothing. File names may contain a
/// tail number, so they are listed only when explicitly requested and never written to a file by the probe.
/// </summary>
public static class GsxReceiptsInventory
{
    /// <summary>Group folders named in the GSX Pro 4.0.0 release notes. The real layout is unverified.</summary>
    public static readonly IReadOnlyList<string> DocumentedGroups = ["Fuel", "Catering", "Handling", "PassengerBus"];

    /// <summary>Per-group cap on listed files; counting stops there and the group is marked truncated.</summary>
    public const int MaxFilesPerGroup = 10_000;

    /// <summary><c>%APPDATA%\Virtuali\GSX\Receipts</c> (Roaming application data on Windows).</summary>
    public static string DefaultRoot() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Virtuali", "GSX", "Receipts");

    public static GsxReceiptsInventoryResult Scan(string root, bool includeFileNames = false)
    {
        ArgumentNullException.ThrowIfNull(root);
        var groups = new List<GsxReceiptGroup>();
        try
        {
            var info = new DirectoryInfo(root);
            if (!info.Exists) return new(root, GsxReceiptsFolderStatus.NotFound, null, groups, DocumentedGroups);
            if (info.Attributes.HasFlag(FileAttributes.ReparsePoint))
            {
                return new(root, GsxReceiptsFolderStatus.Error, "The Receipts folder is a link or junction; it is not followed.", groups, DocumentedGroups);
            }

            var top = new EnumerationOptions { RecurseSubdirectories = false, AttributesToSkip = FileAttributes.ReparsePoint, IgnoreInaccessible = false };
            var loose = ScanFiles(info, top, "(files directly in Receipts)", includeFileNames, documented: false, root);
            if (loose.FileCount > 0 || loose.Error is not null) groups.Add(loose);
            foreach (var dir in info.EnumerateDirectories("*", top).OrderBy(d => d.Name, StringComparer.OrdinalIgnoreCase))
            {
                var documented = DocumentedGroups.Contains(dir.Name, StringComparer.OrdinalIgnoreCase);
                var nested = new EnumerationOptions { RecurseSubdirectories = true, AttributesToSkip = FileAttributes.ReparsePoint, IgnoreInaccessible = false };
                groups.Add(ScanFiles(dir, nested, dir.Name, includeFileNames, documented, root));
            }
        }
        catch (UnauthorizedAccessException)
        {
            return new(root, GsxReceiptsFolderStatus.AccessDenied, "Windows denied access to the Receipts folder.", groups, DocumentedGroups);
        }
        catch (IOException ex)
        {
            return new(root, GsxReceiptsFolderStatus.Error, ex.GetType().Name, groups, DocumentedGroups);
        }

        var missing = DocumentedGroups.Where(g => !groups.Any(x => string.Equals(x.Name, g, StringComparison.OrdinalIgnoreCase))).ToList();
        return new(root, GsxReceiptsFolderStatus.Found, null, groups, missing);
    }

    private static GsxReceiptGroup ScanFiles(DirectoryInfo dir, EnumerationOptions options, string name, bool includeFileNames, bool documented, string root)
    {
        int count = 0, html = 0;
        long bytes = 0;
        DateTime? oldest = null, newest = null;
        var truncated = false;
        var files = new List<GsxReceiptFile>();
        try
        {
            foreach (var f in dir.EnumerateFiles("*", options))
            {
                if (count >= MaxFilesPerGroup)
                {
                    truncated = true;
                    break;
                }
                count++;
                // Metadata only (FileInfo from the directory listing); the file is never opened.
                var ext = f.Extension;
                if (ext.Equals(".html", StringComparison.OrdinalIgnoreCase) || ext.Equals(".htm", StringComparison.OrdinalIgnoreCase)) html++;
                bytes += f.Length;
                var t = f.LastWriteTimeUtc;
                if (oldest is null || t < oldest) oldest = t;
                if (newest is null || t > newest) newest = t;
                if (includeFileNames) files.Add(new GsxReceiptFile(Path.GetRelativePath(root, f.FullName), f.Length, t));
            }
        }
        catch (UnauthorizedAccessException)
        {
            return new(name, documented, count, html, bytes, oldest, newest, truncated, "access denied", files);
        }
        catch (IOException ex)
        {
            return new(name, documented, count, html, bytes, oldest, newest, truncated, ex.GetType().Name, files);
        }
        return new(name, documented, count, html, bytes, oldest, newest, truncated, null, [.. files.OrderBy(x => x.RelativePath, StringComparer.OrdinalIgnoreCase)]);
    }
}
