defmodule OpenQRWeb.Dashboard.LoginLive.MagicLink do
  use OpenQRWeb, :live_view

  @impl true
  def mount(%{"token" => token}, _session, socket) do
    {:ok,
     socket
     |> assign(:page_title, "Magic Link Sign In")
     |> assign(:token, token)}
  end
end
