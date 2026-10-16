import AppKit
import Foundation
import Sparkle

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var updaterController: SPUStandardUpdaterController?
    private var serverProcess: Process?
    private var serverLog: FileHandle?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.accessory)
        buildMenu()
        startStudio()
        if Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String != nil,
           Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String != nil {
            updaterController = SPUStandardUpdaterController(
                startingUpdater: true,
                updaterDelegate: nil,
                userDriverDelegate: self
            )
            buildMenu()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        serverProcess?.terminate()
        try? serverLog?.close()
    }

    private func buildMenu() {
        let item = statusItem ?? NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "K"
        item.button?.toolTip = "KAZAK studio"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Открыть KAZAK studio", action: #selector(openStudio), keyEquivalent: "o"))
        if let updaterController {
            menu.addItem(NSMenuItem.separator())
            let update = NSMenuItem(title: "Проверить обновления…", action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "u")
            update.target = updaterController
            menu.addItem(update)
        }
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Выйти", action: #selector(quit), keyEquivalent: "q"))
        item.menu = menu
        statusItem = item
    }

    @objc private func openStudio() {
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:4317")!)
    }

    @objc private func quit() {
        NSApplication.shared.terminate(nil)
    }

    private func startStudio() {
        let resources = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources")
        let runtime = resources.appendingPathComponent("runtime")
        let node = resources.appendingPathComponent("node/bin/node")
        let support = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/KAZAK studio API", isDirectory: true)
        let logURL = support.appendingPathComponent("runtime.log")
        do {
            try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
            }
            let log = try FileHandle(forWritingTo: logURL)
            try log.seekToEnd()
            serverLog = log
            let process = Process()
            process.executableURL = node
            process.arguments = [runtime.appendingPathComponent("launch.mjs").path]
            process.currentDirectoryURL = runtime
            var environment = ProcessInfo.processInfo.environment
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            environment["PATH"] = [
                "\(home)/.local/bin",
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
                environment["PATH"] ?? ""
            ].joined(separator: ":")
            process.environment = environment
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = log
            process.standardError = log
            try process.run()
            serverProcess = process
        } catch {
            let alert = NSAlert()
            alert.messageText = "Не удалось запустить KAZAK studio"
            alert.informativeText = "\(error.localizedDescription)\n\nПереустановите приложение из GitHub Releases."
            alert.runModal()
            NSApplication.shared.terminate(nil)
        }
    }
}

// Приложение живёт в строке меню, без окна: окно с предложением обновиться выводим на передний план само.
extension AppDelegate: SPUStandardUserDriverDelegate {
    nonisolated var supportsGentleScheduledUpdateReminders: Bool { true }

    nonisolated func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState) {
        Task { @MainActor in NSApplication.shared.activate(ignoringOtherApps: true) }
    }
}

@main
struct KazakStudioApp {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
