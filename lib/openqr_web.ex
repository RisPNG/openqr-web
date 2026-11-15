defmodule OpenQRWeb do
  @moduledoc """
  The entrypoint for defining your web interface, such as controllers, components, channels, and so on.

  This can be used in your application as:

      use OpenQRWeb, :controller
      use OpenQRWeb, :html

  The definitions below will be executed for every controller, component, etc, so keep them short and clean, focused on imports, uses and aliases.

  Do NOT define functions inside the quoted expressions below. Instead, define additional modules and import those modules here.
  """

  def static_paths, do: ~w(assets fonts images favicon.ico robots.txt)

  def router do
    quote do
      use Phoenix.Router, helpers: false

      # Import common connection and controller functions to use in pipelines
      import Plug.Conn
      import Phoenix.Controller
      import Phoenix.LiveView.Router
    end
  end

  def channel do
    quote do
      use Phoenix.Channel
    end
  end

  def controller do
    quote do
      use Phoenix.Controller, formats: [:html, :json]
      import Phoenix.Controller, except: [put_flash: 3]
      import OpenQRWeb.CoreComponents.Flash, only: [put_flash: 3]

      use Gettext, backend: OpenQRWeb.Gettext

      import Plug.Conn

      unquote(verified_routes())
    end
  end

  def live_view do
    quote do
      use Phoenix.LiveView
      import Phoenix.LiveView, except: [put_flash: 3]
      import OpenQRWeb.CoreComponents.Flash, only: [put_flash: 3]

      on_mount {OpenQRWeb.LiveNavigation, :timezone}
      on_mount {OpenQRWeb.CoreComponents, :inputs}

      unquote(html_helpers())
    end
  end

  def live_component do
    quote do
      use Phoenix.LiveComponent
      import Phoenix.LiveView, except: [put_flash: 3]
      import OpenQRWeb.CoreComponents.Flash, only: [put_flash: 3]

      unquote(html_helpers())
    end
  end

  def html do
    quote do
      use Phoenix.Component

      # Import convenience functions from controllers
      import Phoenix.Controller,
        only: [get_csrf_token: 0, view_module: 1, view_template: 1]

      # Include general helpers for rendering HTML
      unquote(html_helpers())
    end
  end

  defp html_helpers do
    quote do
      # Translation
      use Gettext, backend: OpenQRWeb.Gettext

      # HTML escaping functionality
      import Phoenix.HTML
      # Core UI components
      import Phoenix.Component, except: [form: 1]
      import OpenQRWeb.CoreComponents

      # Common modules used in templates
      alias Phoenix.LiveView.JS
      alias OpenQRWeb.Layouts

      # Routes generation with the ~p sigil
      unquote(verified_routes())
    end
  end

  def verified_routes do
    quote do
      use Phoenix.VerifiedRoutes,
        endpoint: OpenQRWeb.Endpoint,
        router: OpenQRWeb.Router,
        statics: OpenQRWeb.static_paths()
    end
  end

  @doc """
  When used, dispatch to the appropriate controller/live_view/etc.
  """
  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
