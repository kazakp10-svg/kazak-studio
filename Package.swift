// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "kazak-studio-launcher",
    platforms: [.macOS(.v12)],
    products: [.executable(name: "kazak-studio", targets: ["KazakStudio"])],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.0")
    ],
    targets: [
        .executableTarget(
            name: "KazakStudio",
            dependencies: [.product(name: "Sparkle", package: "Sparkle")]
        )
    ]
)
