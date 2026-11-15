defmodule OpenQRWeb.ConnCase do
  @moduledoc """
  This module defines the test case for requests and LiveViews.
  """

  use ExUnit.CaseTemplate

  using do
    quote do
      @endpoint OpenQRWeb.Endpoint

      use OpenQRWeb, :verified_routes

      import Plug.Conn
      import Phoenix.ConnTest
    end
  end

  setup do
    {:ok, conn: Phoenix.ConnTest.build_conn()}
  end
end
