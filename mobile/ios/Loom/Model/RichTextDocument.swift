import Foundation

/// Native Markdown parsing belongs to Foundation. This only groups its presentation intents
/// into blocks SwiftUI can lay out, preserving inline attributes and the order of the runs.
struct RichTextDocument: Sendable {
    struct Block: Identifiable, Sendable {
        let id: Int
        let kind: PresentationIntent.Kind
        let text: AttributedString
        let children: [Block]
    }

    let blocks: [Block]

    static func permits(_ url: URL) -> Bool {
        ["https", "http"].contains(url.scheme?.lowercased() ?? "") && url.host != nil
    }

    init(_ source: String) {
        let options = AttributedString.MarkdownParsingOptions(failurePolicy: .returnPartiallyParsedIfPossible)
        let parsed = (try? AttributedString(markdown: source, options: options)) ?? AttributedString(source)
        var roots: [Builder] = []
        var nodes: [Int: Builder] = [:]
        for run in parsed.runs {
            let path = run.presentationIntent?.components.reversed().map { $0 } ?? []
            var parent: Builder?
            for intent in path {
                let node: Builder
                if let existing = nodes[intent.identity] {
                    node = existing
                } else {
                    node = Builder(id: intent.identity, kind: intent.kind)
                    nodes[intent.identity] = node
                    if let parent { parent.children.append(node) } else { roots.append(node) }
                }
                parent = node
            }
            if parent == nil {
                let paragraph = Builder(id: -(roots.count + 1), kind: .paragraph)
                roots.append(paragraph)
                parent = paragraph
            }
            var inline = AttributedString(parsed[run.range])
            // Images remain alt text. Local links only reach the current workspace's reader.
            inline.presentationIntent = nil
            inline.imageURL = nil
            if let link = inline.link {
                if let path = ChatFileLink.path(link.absoluteString) { inline.link = ChatFileLink.url(path) }
                else if !Self.permits(link) { inline.link = nil }
            } else if run.imageURL == nil, run.inlinePresentationIntent?.contains(.code) != true,
                      !path.contains(where: { if case .codeBlock = $0.kind { return true }; return false }) {
                inline = ChatFileLink.linkProse(inline)
            }
            parent?.text.append(inline)
        }
        blocks = roots.map { $0.finish() }
    }

    private final class Builder {
        let id: Int
        let kind: PresentationIntent.Kind
        var text = AttributedString()
        var children: [Builder] = []

        init(id: Int, kind: PresentationIntent.Kind) { self.id = id; self.kind = kind }
        func finish() -> Block { Block(id: id, kind: kind, text: text, children: children.map { $0.finish() }) }
    }
}
