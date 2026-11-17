defmodule OpenQR.DefaultQRTest do
  use ExUnit.Case, async: false

  @moduletag :tmp_dir
  @payload "https://openqr.my"
  @entry_keys ~w(version seed preview format payload verified_frames total_frames error_correction)a

  setup_all do
    {:ok, generated} =
      OpenQR.Engine.generate(@payload,
        version: 0,
        scale: 3,
        seed: 71,
        color: true,
        mode: :mosaic,
        vary_url: false,
        body_shape: "rounded",
        eye_frame: "rounded-dots",
        eye_ball: "dots"
      )

    assert generated.skipped == []
    assert Enum.map(generated.results, & &1.version) == Enum.to_list(1..40)

    results =
      Enum.map(generated.results, fn entry ->
        preview =
          case OpenQR.Engine.inspect_image(entry.preview, @payload) do
            {:ok, %{verified: true}} -> entry.preview
            _ -> entry.image
          end

        assert {:ok, %{verified: true}} = OpenQR.Engine.inspect_image(preview, @payload)
        entry |> Map.take(@entry_keys) |> Map.put(:preview, preview)
      end)

    categories =
      Map.new([:body, :eye_frame, :eye_ball], fn category ->
        {category, OpenQR.Engine.styles(category) |> Map.keys() |> Enum.sort()}
      end)

    combinations =
      for body <- categories.body,
          frame <- categories.eye_frame,
          ball <- categories.eye_ball,
          do: %{body_shape: body, eye_frame: frame, eye_ball: ball}

    {:ok,
     batch: %{results: results, skipped: []},
     styles: hd(combinations),
     other_styles: Enum.at(combinations, 1),
     combinations: length(combinations),
     body_combinations: length(categories.eye_frame) * length(categories.eye_ball)}
  end

  setup %{tmp_dir: directory} do
    previous = Application.get_env(:openqr, :default_qr_directory)
    Application.put_env(:openqr, :default_qr_directory, Path.join(directory, "catalog"))

    on_exit(fn ->
      if previous do
        Application.put_env(:openqr, :default_qr_directory, previous)
      else
        Application.delete_env(:openqr, :default_qr_directory)
      end

      File.rm_rf!(directory)
    end)

    {:ok, source: Path.join(directory, "source-namespace")}
  end

  test "builds a catalog from a relative cache directory", %{tmp_dir: directory} do
    relative = directory |> Path.join("relative-cache") |> Path.relative_to_cwd()

    assert Path.type(relative) == :relative
    assert Path.type(OpenQR.DefaultQR.directory(relative)) == :absolute

    assert %{evaluated: 0, available: 0} =
             OpenQR.DefaultQR.build_catalog(directory: relative, limit: 0)
  end

  test "publishes exact shared rasters and metadata without changing source presets", context do
    %{batch: batch, source: source, styles: styles, other_styles: other_styles} = context
    first_path = write_source(source, styles, batch)
    write_source(source, other_styles, batch)
    original = File.read!(first_path)
    modified = File.stat!(first_path).mtime
    options = [source_directory: source, limit: 2]

    built = OpenQR.DefaultQR.build_catalog(options)
    assert built.schema == 1
    assert built.payload == @payload
    assert built.combinations == context.combinations
    assert built.total_versions == context.combinations * 40
    assert built.evaluated == 2
    assert built.available == 80
    assert built.skipped == 0
    assert built.unbuilt_versions == (context.combinations - 2) * 40
    refute built.complete
    refute Enum.find(built.bodies, &(&1.id == styles.body_shape)).retired

    assert {:ok, manifest} = OpenQR.DefaultQR.catalog()
    assert manifest["id"] == built.id
    {headers, planes, windows} = read_shards(manifest)
    assert map_size(planes) < 80 * 5
    assert Enum.sort(Map.keys(planes)) == Enum.to_list(0..(map_size(planes) - 1))
    first = find_combination(headers, styles)
    second = find_combination(headers, other_styles)
    assert first["reliable"]
    assert second["reliable"]
    assert first["versions"] == second["versions"]
    assert length(first["versions"]) == 40

    Enum.zip(batch.results, first["versions"])
    |> Enum.each(fn {entry, [body_id | patch_ids]} ->
      plane = Map.fetch!(planes, body_id)
      boxes = Map.fetch!(windows, Integer.to_string(body_id))
      assert length(boxes) == 4
      restored = restore_preview(plane, patch_ids, boxes, planes)
      rgba = for <<value <- restored>>, into: <<>>, do: <<value, value, value, 255>>
      assert {:ok, inspected} = OpenQR.Engine.inspect_image(entry.preview, @payload)
      assert inspected.verified
      assert {plane.width, plane.height} == {inspected.width, inspected.height}
      assert rgba == inspected.pixels
    end)

    assert {:ok, showcase} = OpenQR.DefaultQR.showcase(styles)
    assert showcase.catalog_id == built.id
    assert showcase.skipped == []

    Enum.zip(batch.results, showcase.results)
    |> Enum.each(fn {source_entry, entry} ->
      assert Map.take(entry, @entry_keys -- [:preview]) == Map.delete(source_entry, :preview)
      assert entry.seed == 71
      assert length(entry.raster_refs) == 5
      assert length(entry.windows) == 4
      refute Map.has_key?(entry, :preview)
      refute Map.has_key?(entry, :preview_url)
    end)

    assert OpenQR.DefaultQR.fetch(styles, source_directory: source) == {:ok, batch}
    assert File.read!(first_path) == original
    assert File.stat!(first_path).mtime == modified
    assert Path.dirname(first_path) == source
    refute File.exists?(Path.join(OpenQR.DefaultQR.directory(), Path.basename(first_path)))

    [shard | _] = manifest["shards"]
    namespace = Path.basename(OpenQR.DefaultQR.directory())

    assert {:ok, %{path: shard_path, sha256: hash}} =
             OpenQR.DefaultQR.catalog_shard(namespace, shard["name"])

    assert hash == shard["sha256"]
    assert shard_path == Path.join(OpenQR.DefaultQR.directory(), shard["name"])
    assert OpenQR.DefaultQR.catalog_shard("obsolete", shard["name"]) == :missing
    assert OpenQR.DefaultQR.catalog_shard(namespace, "../" <> shard["name"]) == :missing

    assert OpenQR.DefaultQR.catalog_shard(namespace, String.duplicate("f", 64) <> ".bin") ==
             :missing

    manifest_path = Path.join(OpenQR.DefaultQR.directory(), "catalog.json")
    published = File.read!(manifest_path)
    assert OpenQR.DefaultQR.build_catalog(options).id == built.id
    assert File.read!(manifest_path) == published
    File.write!(shard_path, "changed immutable shard")

    assert_raise RuntimeError, ~r/immutable catalog shard has different contents/, fn ->
      OpenQR.DefaultQR.build_catalog(options)
    end

    assert File.read!(shard_path) == "changed immutable shard"
    assert File.read!(manifest_path) == published
    assert File.read!(first_path) == original
    assert Path.wildcard(Path.join(OpenQR.DefaultQR.directory(), ".catalog-build-*")) == []
  end

  test "excludes partial designs and retires bodies after complete reliability evaluation",
       context do
    %{batch: batch, source: source, styles: styles, other_styles: other_styles} = context
    write_source(source, styles, batch)

    non_qr =
      Base.decode64!(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6G7QAAAAASUVORK5CYII="
      )

    [first | rest] = batch.results
    partial = %{batch | results: [%{first | preview: non_qr} | rest]}
    write_source(source, other_styles, partial)
    built = OpenQR.DefaultQR.build_catalog(source_directory: source)
    assert built.complete
    assert built.evaluated == context.combinations
    assert built.available == 79
    assert built.skipped == built.total_versions - 79
    assert built.unbuilt_versions == 0
    assert Enum.all?(built.bodies, & &1.retired)
    body = Enum.find(built.bodies, &(&1.id == styles.body_shape))
    assert body.available == 79
    assert body.skipped == context.body_combinations * 40 - 79
    assert body.reliable_combinations == 1
    assert body.pairs == []
    assert body.reason == "more-unreliable-previews"
    assert OpenQR.DefaultQR.showcase(styles) == :missing
    assert OpenQR.DefaultQR.showcase(other_styles) == :missing

    assert {:ok, manifest} = OpenQR.DefaultQR.catalog()
    {headers, planes, _windows} = read_shards(manifest)
    assert planes == %{}

    for header <- headers, combination <- header["combinations"] do
      refute combination["reliable"]
      assert combination["versions"] == List.duplicate(nil, 40)
    end

    partial_metadata = read_metadata(built.id, other_styles)
    assert partial_metadata.results == []
    assert length(partial_metadata.skipped) == 40

    assert partial_metadata.reliability ==
             %{available: 39, skipped: 1, reliable: false, evaluated: true}

    assert Enum.all?(partial_metadata.skipped, &is_binary(&1.reason))

    published_names =
      OpenQR.DefaultQR.directory()
      |> Path.join("*.bin")
      |> Path.wildcard()
      |> Enum.map(&Path.basename/1)
      |> Enum.sort()

    assert published_names == Enum.sort(Enum.map(manifest["shards"], & &1["name"]))
    assert Path.wildcard(Path.join(OpenQR.DefaultQR.directory(), ".catalog-build-*")) == []
  end

  test "rejects missing, malformed, unsafe, and incomplete inputs without generation", context do
    %{source: source, styles: styles, batch: batch} = context
    assert OpenQR.DefaultQR.fetch(styles, source_directory: source) == :missing
    assert OpenQR.DefaultQR.showcase(styles) == :missing
    assert OpenQR.DefaultQR.catalog() == :missing
    refute File.exists?(OpenQR.DefaultQR.directory())

    path = write_source(source, styles, batch)
    atom = "unknown_default_qr_atom_#{System.unique_integer([:positive])}"
    File.write!(path, <<131, 100, byte_size(atom)::16, atom::binary>>)
    assert OpenQR.DefaultQR.fetch(styles, source_directory: source) == :missing
    assert_raise ArgumentError, fn -> String.to_existing_atom(atom) end

    File.write!(
      path,
      :erlang.term_to_binary(
        {1, {styles.body_shape, styles.eye_frame, styles.eye_ball}, %{results: [], skipped: []}}
      )
    )

    assert OpenQR.DefaultQR.fetch(styles, source_directory: source) == :missing
    File.write!(path, "corrupt ETF")
    assert OpenQR.DefaultQR.fetch(styles, source_directory: source) == :missing
    assert File.read!(path) == "corrupt ETF"

    assert_raise ArgumentError, ~r/source directory must be absolute/, fn ->
      OpenQR.DefaultQR.build_catalog(source_directory: "relative-source", limit: 0)
    end

    refute File.exists?(OpenQR.DefaultQR.directory())
    File.mkdir_p!(OpenQR.DefaultQR.directory())
    manifest_path = Path.join(OpenQR.DefaultQR.directory(), "catalog.json")
    File.write!(manifest_path, "{invalid JSON")
    assert OpenQR.DefaultQR.catalog() == :missing
    assert OpenQR.DefaultQR.showcase(styles) == :missing
    assert %{id: nil, bytes: 0} = OpenQR.DefaultQR.catalog_status()
    assert File.read!(manifest_path) == "{invalid JSON"
    assert Path.wildcard(Path.join(OpenQR.DefaultQR.directory(), ".catalog-build-*")) == []
  end

  defp write_source(directory, styles, batch) do
    File.mkdir_p!(directory)

    name =
      :crypto.hash(
        :sha256,
        :erlang.term_to_binary({styles.body_shape, styles.eye_frame, styles.eye_ball})
      )
      |> Base.encode16(case: :lower)

    path = Path.join(directory, name <> ".etf")

    File.write!(
      path,
      :erlang.term_to_binary({1, {styles.body_shape, styles.eye_frame, styles.eye_ball}, batch}, [
        :compressed
      ])
    )

    path
  end

  defp read_shards(manifest) do
    Enum.reduce(manifest["shards"], {[], %{}, %{}}, fn shard, {headers, planes, windows} ->
      compressed = File.read!(Path.join(OpenQR.DefaultQR.directory(), shard["name"]))
      assert byte_size(compressed) == shard["bytes"]
      assert Base.encode16(:crypto.hash(:sha256, compressed), case: :lower) == shard["sha256"]
      assert shard["name"] == shard["sha256"] <> ".bin"
      raw = :zlib.gunzip(compressed)
      assert byte_size(raw) == shard["raw_bytes"]
      assert Base.encode16(:crypto.hash(:sha256, raw), case: :lower) == shard["raw_sha256"]
      <<"OQR1", length::little-unsigned-32, json::binary-size(length), pixels::binary>> = raw
      header = Jason.decode!(json)

      planes =
        Enum.reduce(header["planes"], planes, fn plane, planes ->
          assert plane["length"] == plane["width"] * plane["height"]
          refute Map.has_key?(planes, plane["id"])

          value = %{
            width: plane["width"],
            height: plane["height"],
            pixels: binary_part(pixels, plane["offset"], plane["length"])
          }

          Map.put(planes, plane["id"], value)
        end)

      {[header | headers], planes, Map.merge(windows, header["windows"])}
    end)
  end

  defp find_combination(headers, styles) do
    headers
    |> Enum.filter(&(&1["body"] == styles.body_shape))
    |> Enum.flat_map(& &1["combinations"])
    |> Enum.find(&(&1["frame"] == styles.eye_frame and &1["ball"] == styles.eye_ball))
  end

  defp restore_preview(body, patch_ids, boxes, planes) do
    runs =
      Enum.zip(patch_ids, boxes)
      |> Enum.flat_map(fn {id, [x, y, width, height]} ->
        patch = Map.fetch!(planes, id)
        assert {patch.width, patch.height} == {width, height}

        for row <- 0..(height - 1),
            do: {(y + row) * body.width + x, binary_part(patch.pixels, row * width, width)}
      end)
      |> Enum.sort_by(&elem(&1, 0))

    {parts, cursor} =
      Enum.reduce(runs, {[], 0}, fn {offset, pixels}, {parts, cursor} ->
        {[parts, binary_part(body.pixels, cursor, offset - cursor), pixels],
         offset + byte_size(pixels)}
      end)

    IO.iodata_to_binary([
      parts,
      binary_part(body.pixels, cursor, byte_size(body.pixels) - cursor)
    ])
  end

  defp read_metadata(catalog_id, styles) do
    name =
      :crypto.hash(
        :sha256,
        :erlang.term_to_binary({styles.body_shape, styles.eye_frame, styles.eye_ball})
      )
      |> Base.encode16(case: :lower)

    {1, _styles, batch} =
      OpenQR.DefaultQR.directory()
      |> Path.join("catalog-#{catalog_id}")
      |> Path.join(name <> ".etf")
      |> File.read!()
      |> :erlang.binary_to_term([:safe])

    batch
  end
end

defmodule OpenQR.DefaultQRCatalogMetadataTest do
  use ExUnit.Case, async: false

  @moduletag :tmp_dir
  @styles %{body_shape: "rounded", eye_frame: "rounded-dots", eye_ball: "dots"}
  @payload "https://openqr.my"

  test "rejects malformed published metadata before it reaches a LiveView", %{tmp_dir: directory} do
    previous = Application.get_env(:openqr, :default_qr_directory)
    Application.put_env(:openqr, :default_qr_directory, directory)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:openqr, :default_qr_directory, previous),
        else: Application.delete_env(:openqr, :default_qr_directory)

      File.rm_rf!(directory)
    end)

    catalog_id = String.duplicate("a", 64)
    published = Path.join(OpenQR.DefaultQR.directory(), "catalog-#{catalog_id}")
    File.mkdir_p!(published)

    manifest = %{
      schema: 1,
      payload: @payload,
      id: catalog_id,
      shards: [],
      complete: true,
      bodies: [
        %{id: @styles.body_shape, retired: false, pairs: [[@styles.eye_frame, @styles.eye_ball]]}
      ]
    }

    File.write!(Path.join(OpenQR.DefaultQR.directory(), "catalog.json"), Jason.encode!(manifest))

    results =
      Enum.map(1..40, fn version ->
        side = (25 + 4 * version) * 3

        %{
          version: version,
          seed: 71,
          payload: @payload,
          format: :png,
          verified_frames: 1,
          total_frames: 1,
          error_correction: "H",
          raster_refs: Enum.to_list((version * 5)..(version * 5 + 4)),
          width: side,
          height: side,
          windows: [
            [12, 12, 21, 21],
            [side - 33, 12, 21, 21],
            [12, side - 33, 21, 21],
            [side - 33, side - 33, 21, 21]
          ]
        }
      end)

    styles = {@styles.body_shape, @styles.eye_frame, @styles.eye_ball}

    name =
      Base.encode16(:crypto.hash(:sha256, :erlang.term_to_binary(styles)), case: :lower) <> ".etf"

    path = Path.join(published, name)

    File.write!(
      path,
      :erlang.term_to_binary({1, styles, %{results: results, skipped: []}}, [:compressed])
    )

    assert {:ok, %{results: ^results, catalog_id: ^catalog_id}} =
             OpenQR.DefaultQR.showcase(@styles)

    [first | rest] = results

    for invalid <- [
          %{garbage: true},
          %{first | version: 2},
          %{first | seed: -1},
          %{first | seed: 1.5},
          %{first | payload: "https://example.com"},
          %{first | format: :gif},
          %{first | verified_frames: 0},
          %{first | total_frames: 2},
          %{first | error_correction: "invalid"},
          %{first | raster_refs: [0, 1, 2, 3]},
          %{first | raster_refs: [0, 1, 2, 3, -1]},
          %{first | width: 0},
          %{first | height: "87"},
          %{first | windows: [[0, 0, 1, 1]]},
          %{first | windows: List.duplicate([0, 0, 1000, 1000], 4)}
        ] do
      File.write!(
        path,
        :erlang.term_to_binary({1, styles, %{results: [invalid | rest], skipped: []}}, [
          :compressed
        ])
      )

      assert OpenQR.DefaultQR.showcase(@styles) == :missing
    end
  end
end
