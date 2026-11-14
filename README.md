# OpenQR Web

OpenQR Web is the Elixir, Phoenix LiveView, and Ash application. QR generation runs in the separate [OpenQR native engine](../openqr), through the `openqr_engine` dependency. The web application owns authentication, account administration, page permissions, and persistence.

The engine builds through CMake when Mix compiles its Elixir binding. Run project commands through mise, including `mise exec -- mix compile`. Generate a QR code with `OpenQR.Engine.generate("https://example.com", version: 5, seed: 42)`. The result contains encoded images, SVG, previews, and verification metadata.

For setup, development, and deployment, see the [development guide](dev/README.md).
