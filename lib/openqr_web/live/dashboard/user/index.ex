defmodule OpenQRWeb.Dashboard.UserLive.Index do
  use OpenQRWeb, :live_view

  alias OpenQR.Accounts.User
  alias OpenQRWeb.Dashboard.UserLive.Deletion

  on_mount {OpenQRWeb.LiveUserAuth, {:require_page_access, "/dashboard/admin/users"}}
  on_mount {Deletion, :index}

  @impl true
  def mount(_params, _session, socket) do
    {:ok,
     socket
     |> assign(:page_title, "Users")
     |> assign(:query, Ash.Query.sort(User, inserted_at: :desc))}
  end
end
