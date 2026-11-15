import SwiftUI

private struct ChatFileActionKey: EnvironmentKey {
    static let defaultValue: ((String) -> Void)? = nil
}

extension EnvironmentValues {
    var openChatFile: ((String) -> Void)? {
        get { self[ChatFileActionKey.self] }
        set { self[ChatFileActionKey.self] = newValue }
    }
}

/// Selectable native text; parsing runs off the main thread while streamed content arrives.
struct MarkdownText: View {
    let text: String
    @Environment(\.openChatFile) private var openFile
    @State private var document = RichTextDocument("")
    @State private var parser = MarkdownParser()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(document.blocks) { RichTextBlock(block: $0) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .tint(LoomStyle.link)
        .task(id: text) {
            if let parsed = await parser.parse(text), !Task.isCancelled { document = parsed }
        }
        .environment(\.openURL, OpenURLAction { url in
            if let path = ChatFileLink.path(url.absoluteString) {
                guard let openFile else { return .discarded }
                openFile(path)
                return .handled
            }
            return RichTextDocument.permits(url) ? .systemAction : .discarded
        })
    }
}

/// Foundation's parser is synchronous. Serial ownership keeps rapid streaming updates from
/// creating overlapping parses; cancelled updates waiting their turn are skipped altogether.
private actor MarkdownParser {
    func parse(_ source: String) -> RichTextDocument? {
        guard !Task.isCancelled else { return nil }
        return RichTextDocument(source)
    }
}

private struct RichTextBlock: View {
    let block: RichTextDocument.Block
    var ordered = false

    @ViewBuilder var body: some View {
        switch block.kind {
        case .header(let level):
            nativeText
                .font(level == 1 ? .title2.weight(.bold) : level == 2 ? .title3.weight(.bold) : .headline)
                .padding(.top, 4)
                .accessibilityAddTraits(.isHeader)
        case .codeBlock:
            ScrollView(.horizontal) {
                nativeText.font(.callout.monospaced()).fixedSize(horizontal: true, vertical: false).padding(12)
            }
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
        case .orderedList:
            children(ordered: true)
        case .unorderedList:
            children()
        case .listItem(let ordinal):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ordered ? "\(ordinal)." : "•").foregroundStyle(LoomStyle.secondary).monospacedDigit()
                children()
            }
        case .blockQuote:
            children().foregroundStyle(LoomStyle.secondary).padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(Color(.separator)).frame(width: 3) }
        case .thematicBreak:
            Divider()
        case .table(let columns):
            ScrollView(.horizontal) {
                Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                    ForEach(block.children) { row in
                        GridRow {
                            ForEach(Array(columns.enumerated()), id: \.offset) { index, column in
                                let cell = row.children.first { $0.kind == .tableCell(columnIndex: index) }
                                Text(cell?.text ?? AttributedString())
                                    .fontWeight(row.kind == .tableHeaderRow ? .semibold : .regular)
                                    .textSelection(.enabled)
                                    .frame(minWidth: 100, maxWidth: 200, alignment: alignment(column.alignment))
                                    .padding(10)
                                    .background(row.kind == .tableHeaderRow ? Color(.secondarySystemBackground) : Color.clear)
                                    .overlay(alignment: .bottom) { Divider() }
                            }
                        }
                    }
                }
                .fixedSize(horizontal: true, vertical: false)
            }
        default:
            if !block.text.characters.isEmpty { nativeText }
            if !block.children.isEmpty { children() }
        }
    }

    private var nativeText: some View {
        Text(block.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func children(ordered: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(block.children) { RichTextBlock(block: $0, ordered: ordered) }
        }
    }

    private func alignment(_ value: PresentationIntent.TableColumn.Alignment) -> Alignment {
        switch value {
        case .left: return .leading
        case .center: return .center
        case .right: return .trailing
        @unknown default: return .leading
        }
    }
}
