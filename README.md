# OpenQR Web

OpenQR Web is an Elixir, Phoenix LiveView, and Ash application built on the database-free foundation and shared standards of Elixirbits `zero`. Its public home page, dashboard, shared components, and development tools are available without signing in.

QR generation runs in the separate [OpenQR native engine](../openqr), through the `openqr_engine` dependency. The engine builds through CMake when Mix compiles its Elixir binding. Run project commands through mise, including `mise exec -- mix compile`. Generate a QR code with `OpenQR.Engine.generate("https://example.com", version: 5, seed: 42)`. The result contains encoded images, SVG, previews, and verification metadata.

For setup, development, and deployment, see the [development guide](dev/README.md).
