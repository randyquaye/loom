import Foundation

/// Chat may open a file in its own workspace, never an arbitrary URL or filesystem root.
enum ChatFileLink {
    static let prefix = "loom-file:"
    static let pattern = #"(?<![\w./:%-])([\w.-]+(?:/[\w.-]+)*\.(?:tsx|jsx|swift|kts|kt|md|json|js|ts|sh|py|tf|css|html|yml|yaml|go|rs|toml|txt))(?::\d+)?(?![\w/-]|\.\w|:\d)"#

    static func path(_ target: String) -> String? {
        let raw = target.hasPrefix(prefix) ? String(target.dropFirst(prefix.count)) : target
        let withoutLine = raw.replacingOccurrences(of: #"(?:#L?\d+|:\d+)$"#, with: "", options: .regularExpression)
        guard var path = withoutLine.removingPercentEncoding else { return nil }
        if path.hasPrefix("./") { path.removeFirst(2) }
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains(where: { "\\:%?#".contains($0) || $0.isNewline }),
              !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return nil }
        return path
    }

    static func url(_ path: String) -> URL? {
        guard let path = self.path(path),
              let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
        return URL(string: prefix + encoded)
    }

    static func linkProse(_ text: AttributedString) -> AttributedString {
        var linked = text
        let source = String(text.characters)
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return text }
        for match in expression.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
            guard let range = Range(match.range, in: source), let pathRange = Range(match.range(at: 1), in: source),
                  let target = url(String(source[pathRange])) else { continue }
            let start = linked.characters.index(linked.startIndex, offsetBy: source.distance(from: source.startIndex, to: range.lowerBound))
            let end = linked.characters.index(linked.startIndex, offsetBy: source.distance(from: source.startIndex, to: range.upperBound))
            linked[start..<end].link = target
        }
        return linked
    }
}
