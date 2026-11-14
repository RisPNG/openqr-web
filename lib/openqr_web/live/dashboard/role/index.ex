defmodule OpenQRWeb.Dashboard.RoleLive.Index do
  use OpenQRWeb, :live_view

  alias OpenQR.AccessControl.Role
  alias OpenQRWeb.Dashboard.RoleLive.Deletion

  on_mount {OpenQRWeb.LiveUserAuth, {:require_page_access, "/dashboard/admin/roles"}}
  on_mount {Deletion, :index}

  @impl true
  def mount(_params, _session, socket) do
    {:ok,
     socket
     |> assign(:page_title, "Roles")
     |> assign(:query, Ash.Query.sort(Role, name: :asc))}
  end
end
