defmodule OpenQRWeb.IndexLiveTest do
  use OpenQRWeb.ConnCase, async: true

  import Phoenix.LiveViewTest

  test "public home remains blank", %{conn: conn} do
    {:ok, view, html} = live(conn, ~p"/")
    document = Floki.parse_document!(html)

    assert document |> Floki.find("title") |> Floki.text() |> String.trim() == "OpenQR"
    assert document |> Floki.find("body") |> Floki.text() |> String.trim() == ""
    assert render(view) |> Floki.parse_fragment!() |> Floki.find("[data-phx-main] *") == []
  end
end
