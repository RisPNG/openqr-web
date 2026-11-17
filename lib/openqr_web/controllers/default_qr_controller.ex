defmodule OpenQRWeb.DefaultQRController do
  use OpenQRWeb, :controller

  alias OpenQR.DefaultQR

  def catalog(conn, %{"namespace" => namespace}) do
    with true <- namespace == Path.basename(DefaultQR.directory()),
         {:ok, catalog} <- DefaultQR.catalog() do
      conn
      |> put_resp_content_type("application/json", nil)
      |> put_resp_header("cache-control", "no-cache")
      |> put_resp_header("x-content-type-options", "nosniff")
      |> send_resp(200, Jason.encode!(catalog))
    else
      _ ->
        conn
        |> put_resp_header("cache-control", "no-store")
        |> put_resp_header("x-content-type-options", "nosniff")
        |> send_resp(404, "Not Found")
    end
  end

  def shard(conn, %{"namespace" => namespace, "name" => name}) do
    with {:ok, %{path: path, sha256: hash}} <- DefaultQR.catalog_shard(namespace, name) do
      etag = "\"" <> hash <> "\""

      conn =
        conn
        |> put_resp_content_type("application/octet-stream", nil)
        |> put_resp_header("content-encoding", "gzip")
        |> put_resp_header("cache-control", "public, max-age=31536000, immutable")
        |> put_resp_header("etag", etag)
        |> put_resp_header("x-content-type-options", "nosniff")

      fresh? =
        conn
        |> get_req_header("if-none-match")
        |> Enum.flat_map(&Plug.Conn.Utils.list/1)
        |> Enum.any?(fn candidate ->
          candidate == "*" or String.trim_leading(candidate, "W/") == etag
        end)

      if fresh?, do: send_resp(conn, 304, ""), else: send_file(conn, 200, path)
    else
      _ ->
        conn
        |> put_resp_header("cache-control", "no-store")
        |> put_resp_header("x-content-type-options", "nosniff")
        |> send_resp(404, "Not Found")
    end
  end
end
