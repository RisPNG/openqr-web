defmodule OpenQRWeb.Presence do
  use Phoenix.Presence,
    otp_app: :openqr,
    pubsub_server: OpenQR.PubSub
end
