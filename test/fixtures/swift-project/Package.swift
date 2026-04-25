// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SwiftProject",
    products: [
        .library(name: "SwiftProject", targets: ["SwiftProject"]),
    ],
    targets: [
        .target(name: "SwiftProject", path: "Sources"),
    ]
)
