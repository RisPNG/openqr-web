defmodule OpenQRWeb.DefaultQRControllerTest do
  use OpenQRWeb.ConnCase, async: false

  @endpoint OpenQRWeb.Router
  @moduletag :tmp_dir

  setup %{tmp_dir: directory} do
    previous = Application.get_env(:openqr, :default_qr_directory)
    Application.put_env(:openqr, :default_qr_directory, directory)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:openqr, :default_qr_directory, previous),
        else: Application.delete_env(:openqr, :default_qr_directory)

      File.rm_rf!(directory)
    end)

    namespace = Path.basename(OpenQR.DefaultQR.directory())
    {:ok, prefix: "/qr-defaults/#{namespace}"}
  end

  test "revalidates the manifest and streams immutable gzip shards with content hashes", %{
    conn: conn,
    prefix: prefix
  } do
    {manifest, compressed, raw} = write_catalog()
    response = get(conn, prefix <> "/catalog.json")
    assert json_response(response, 200) == manifest
    assert get_resp_header(response, "cache-control") == ["no-cache"]
    assert get_resp_header(response, "x-content-type-options") == ["nosniff"]
    [shard] = manifest["shards"]

    asset = get(build_conn(), prefix <> "/" <> shard["name"])
    assert response(asset, 200) == compressed
    assert :zlib.gunzip(asset.resp_body) == raw
    assert get_resp_header(asset, "content-type") == ["application/octet-stream"]
    assert get_resp_header(asset, "content-encoding") == ["gzip"]
    assert get_resp_header(asset, "cache-control") == ["public, max-age=31536000, immutable"]
    assert get_resp_header(asset, "etag") == ["\"#{shard["sha256"]}\""]
    assert get_resp_header(asset, "x-content-type-options") == ["nosniff"]
    assert Base.encode16(:crypto.hash(:sha256, raw), case: :lower) == shard["raw_sha256"]

    revalidated =
      build_conn()
      |> put_req_header("if-none-match", "\"other\", W/\"#{shard["sha256"]}\"")
      |> get(prefix <> "/" <> shard["name"])

    assert response(revalidated, 304) == ""
    assert get_resp_header(revalidated, "etag") == get_resp_header(asset, "etag")
  end

  test "missing or corrupt manifests do not expose unpublished files", %{
    conn: conn,
    prefix: prefix
  } do
    missing = get(conn, prefix <> "/catalog.json")
    assert response(missing, 404) == "Not Found"
    assert get_resp_header(missing, "cache-control") == ["no-store"]
    refute File.exists?(OpenQR.DefaultQR.directory())

    {manifest, _, _} = write_catalog()
    [shard] = manifest["shards"]
    path = Path.join(OpenQR.DefaultQR.directory(), "catalog.json")
    File.write!(path, "corrupt")

    for suffix <- ["/catalog.json", "/" <> shard["name"]] do
      invalid = get(build_conn(), prefix <> suffix)
      assert response(invalid, 404) == "Not Found"
      assert get_resp_header(invalid, "cache-control") == ["no-store"]
    end

    assert File.read!(path) == "corrupt"
  end

  test "rejects obsolete namespaces, traversal names, and missing shards", %{prefix: prefix} do
    write_catalog()
    namespace = Path.basename(OpenQR.DefaultQR.directory())

    for path <- [
          String.replace(prefix, namespace, "obsolete") <> "/catalog.json",
          prefix <> "/%2e%2e",
          prefix <> "/unlisted.bin",
          prefix <> "/" <> String.duplicate("0", 64) <> ".bin"
        ] do
      invalid = get(build_conn(), path)
      assert response(invalid, 404) == "Not Found"
      assert get_resp_header(invalid, "cache-control") == ["no-store"]
    end
  end

  defp write_catalog do
    header = Jason.encode!(%{body: "rounded", planes: [], combinations: [], windows: %{}})
    raw = "OQR1" <> <<byte_size(header)::little-unsigned-32>> <> header
    compressed = :zlib.gzip(raw)
    hash = Base.encode16(:crypto.hash(:sha256, compressed), case: :lower)

    manifest = %{
      "schema" => 1,
      "payload" => "https://openqr.my",
      "id" => String.duplicate("a", 64),
      "shards" => [
        %{
          "name" => hash <> ".bin",
          "sha256" => hash,
          "raw_sha256" => Base.encode16(:crypto.hash(:sha256, raw), case: :lower),
          "bytes" => byte_size(compressed),
          "raw_bytes" => byte_size(raw)
        }
      ],
      "bodies" => [],
      "combinations" => 0,
      "evaluated" => 0,
      "complete" => true,
      "total_versions" => 0,
      "available" => 0,
      "skipped" => 0
    }

    directory = OpenQR.DefaultQR.directory()
    File.mkdir_p!(directory)
    File.write!(Path.join(directory, hash <> ".bin"), compressed)
    File.write!(Path.join(directory, "catalog.json"), Jason.encode!(manifest))
    {manifest, compressed, raw}
  end
end
