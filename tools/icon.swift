import AppKit
import Foundation
let destination = CommandLine.arguments[1]
for size in [16, 32, 64, 128, 256, 512, 1024] {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()
    NSColor(calibratedRed: 0.13, green: 0.14, blue: 0.15, alpha: 1).setFill()
    NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: size, height: size), xRadius: CGFloat(size) * 0.2, yRadius: CGFloat(size) * 0.2).fill()
    let font = NSFont.systemFont(ofSize: CGFloat(size) * 0.65, weight: .semibold)
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
    let letter = "K" as NSString
    let measured = letter.size(withAttributes: attributes)
    letter.draw(at: NSPoint(x: (CGFloat(size) - measured.width) / 2, y: (CGFloat(size) - measured.height) / 2 + CGFloat(size) * 0.018), withAttributes: attributes)
    image.unlockFocus()
    let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
    try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(destination)/\(size).png"))
}
