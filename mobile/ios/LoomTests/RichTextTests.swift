import XCTest
@testable import Loom

final class RichTextTests: XCTestCase {
    func testTableKeepsCellBoundariesAndInlineFormatting() throws {
        let document = RichTextDocument("""
        | Change | Result |
        | --- | ---: |
        | **Refresh** | `passed` |
        """)
        let table = try XCTUnwrap(document.blocks.first)
        guard case .table(let columns) = table.kind else { return XCTFail("Expected a table") }
        XCTAssertEqual(columns.map(\.alignment), [.left, .right])
        XCTAssertEqual(table.children.count, 2)
        XCTAssertEqual(table.children[0].kind, .tableHeaderRow)
        XCTAssertEqual(table.children[0].children.map { String($0.text.characters) }, ["Change", "Result"])
        let cells = table.children[1].children
        XCTAssertEqual(cells.map { String($0.text.characters) }, ["Refresh", "passed"])
        XCTAssertTrue(cells[0].text.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        XCTAssertTrue(cells[1].text.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
    }

    func testNestedListsAndQuotesRetainTheirParents() throws {
        let document = RichTextDocument("""
        1. Outer
           - Inner

        > Quoted **detail**
        """)
        let list = try XCTUnwrap(document.blocks.first)
        XCTAssertEqual(list.kind, .orderedList)
        XCTAssertEqual(list.children.first?.kind, .listItem(ordinal: 1))
        XCTAssertTrue(list.flattened.contains { $0.kind == .unorderedList })
        XCTAssertTrue(list.flattened.contains { String($0.text.characters) == "Inner" })
        let quote = try XCTUnwrap(document.blocks.last)
        XCTAssertEqual(quote.kind, .blockQuote)
        XCTAssertEqual(quote.children.map { String($0.text.characters) }, ["Quoted detail"])
    }

    func testCodeIsLiteralIncludingMarkdownSyntax() throws {
        let document = RichTextDocument("```swift\nlet text = \"**literal** | cell\"\n// # heading\n```")
        let code = try XCTUnwrap(document.blocks.first)
        XCTAssertEqual(code.kind, .codeBlock(languageHint: "swift"))
        XCTAssertTrue(String(code.text.characters).contains("**literal** | cell"))
        XCTAssertTrue(String(code.text.characters).contains("// # heading"))
        XCTAssertTrue(code.children.isEmpty)
    }

    func testUnfinishedStreamingFenceStillShowsCode() throws {
        let document = RichTextDocument("Working…\n\n```ts\nconst retries = 3")
        let code = try XCTUnwrap(document.blocks.last)
        XCTAssertEqual(code.kind, .codeBlock(languageHint: "ts"))
        XCTAssertEqual(String(code.text.characters).trimmingCharacters(in: .newlines), "const retries = 3")
    }

    func testUntrustedLinksCannotBecomeAppActionsAndImagesRemainAltText() {
        let document = RichTextDocument("""
        [safe](https://example.com/docs) [unsafe](dev.loom.app.ios:/oauth/callback) [script](javascript:alert)

        ![remote picture](https://tracker.invalid/pixel.png)
        """)
        let text = document.blocks.flatMap(\.flattened).map(\.text)
        let links = text.flatMap { $0.runs.compactMap(\.link) }
        XCTAssertEqual(links, [URL(string: "https://example.com/docs")!])
        XCTAssertTrue(text.allSatisfy { $0.runs.allSatisfy { $0.imageURL == nil } })
        XCTAssertTrue(text.contains { String($0.characters).contains("remote picture") })
    }

    func testEmptyTableCellsKeepTheirColumnPositions() throws {
        let document = RichTextDocument("| A | B | C |\n| --- | --- | --- |\n| one | | three |")
        let row = try XCTUnwrap(document.blocks.first?.children.last)
        let cells = Dictionary(uniqueKeysWithValues: row.children.compactMap { child -> (Int, String)? in
            guard case .tableCell(let index) = child.kind else { return nil }
            return (index, String(child.text.characters))
        })
        XCTAssertEqual(cells[0], "one")
        XCTAssertEqual(cells[2], "three")
        XCTAssertTrue(cells[1] == nil || cells[1] == "")
    }
}

private extension RichTextDocument.Block {
    var flattened: [RichTextDocument.Block] { [self] + children.flatMap(\.flattened) }
}
