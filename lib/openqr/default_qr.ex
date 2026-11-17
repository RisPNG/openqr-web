defmodule OpenQR.DefaultQR do
  @moduledoc false

  @payload Application.compile_env!(:openqr, :default_qr_payload)
  @options [version: 0, scale: 3, seed: 42, color: true, mode: :mosaic, vary_url: false]
  @entry_keys ~w(version seed preview format payload verified_frames total_frames error_correction)a

  def directory(
        base_directory \\ Application.get_env(
          :openqr,
          :default_qr_directory,
          Application.app_dir(:openqr, "priv/qr_defaults")
        )
      ) do
    fingerprint =
      case :persistent_term.get({__MODULE__, :engine_fingerprint}, nil) do
        nil ->
          identity = File.read!(Application.app_dir(:openqr_engine, "priv/openqr-build-id.txt"))

          binding_identity =
            File.read!(Application.app_dir(:openqr_engine, "priv/openqr-nif-build-id.txt"))

          fingerprint =
            :crypto.hash(
              :sha256,
              :erlang.term_to_binary({1, @payload, @options, identity, binding_identity})
            )
            |> Base.encode16(case: :lower)

          :persistent_term.put({__MODULE__, :engine_fingerprint}, fingerprint)
          fingerprint

        fingerprint ->
          fingerprint
      end

    Path.join(Path.expand(base_directory), fingerprint)
  end

  def fetch(%{body_shape: body, eye_frame: frame, eye_ball: ball}, options \\ []) do
    directory =
      options[:source_directory] ||
        if(options[:directory], do: directory(options[:directory]), else: directory())

    name =
      :crypto.hash(:sha256, :erlang.term_to_binary({body, frame, ball}))
      |> Base.encode16(case: :lower)

    with {:ok, binary} <- File.read(Path.join(directory, name <> ".etf")) do
      try do
        case :erlang.binary_to_term(binary, [:safe]) do
          {1, {^body, ^frame, ^ball}, %{results: results, skipped: skipped} = batch}
          when is_list(results) and is_list(skipped) ->
            valid_results? =
              Enum.all?(results, fn
                %{
                  version: version,
                  seed: seed,
                  preview: <<137, 80, 78, 71, 13, 10, 26, 10, _::binary>>,
                  format: :png,
                  payload: @payload,
                  verified_frames: 1,
                  total_frames: 1,
                  error_correction: correction
                } ->
                  version in 1..40 and is_integer(seed) and seed in 0..0xFFFFFFFF and
                    correction in ["L", "M", "Q", "H"]

                _ ->
                  false
              end)

            valid_skipped? =
              Enum.all?(skipped, fn
                %{version: version, reason: reason} when is_binary(reason) ->
                  version in 1..40 and reason != ""

                _ ->
                  false
              end)

            if valid_results? and valid_skipped? and
                 Enum.sort(Enum.map(results ++ skipped, & &1.version)) == Enum.to_list(1..40) do
              {:ok, batch}
            else
              :missing
            end

          _ ->
            :missing
        end
      rescue
        ArgumentError -> :missing
      end
    else
      {:error, _} -> :missing
    end
  end

  def showcase(%{body_shape: body, eye_frame: frame, eye_ball: ball}, options \\ []) do
    directory = if options[:directory], do: directory(options[:directory]), else: directory()

    name =
      Base.encode16(:crypto.hash(:sha256, :erlang.term_to_binary({body, frame, ball})),
        case: :lower
      )

    with {:ok, catalog} <- catalog(options),
         %{"retired" => false, "pairs" => pairs} <-
           Enum.find(catalog["bodies"], fn
             %{"id" => ^body} -> true
             _ -> false
           end),
         true <- is_list(pairs) and [frame, ball] in pairs,
         true <- Map.has_key?(OpenQR.Engine.styles(:body), body),
         true <- Map.has_key?(OpenQR.Engine.styles(:eye_frame), frame),
         true <- Map.has_key?(OpenQR.Engine.styles(:eye_ball), ball),
         {:ok, binary} <-
           File.read(Path.join([directory, "catalog-#{catalog["id"]}", name <> ".etf"])) do
      try do
        case :erlang.binary_to_term(binary, [:safe]) do
          {1, {^body, ^frame, ^ball}, %{results: results, skipped: skipped} = batch}
          when is_list(results) and is_list(skipped) and length(results) == 40 and skipped == [] ->
            valid_results? =
              Enum.all?(results, fn
                %{
                  version: version,
                  seed: seed,
                  payload: @payload,
                  format: :png,
                  verified_frames: 1,
                  total_frames: 1,
                  error_correction: correction,
                  raster_refs: refs,
                  width: width,
                  height: height,
                  windows: windows
                } ->
                  is_integer(version) and version in 1..40 and is_integer(seed) and
                    seed in 0..0xFFFFFFFF and correction in ["L", "M", "Q", "H"] and
                    is_list(refs) and length(refs) == 5 and
                    Enum.all?(refs, &(is_integer(&1) and &1 >= 0)) and
                    is_integer(width) and width > 0 and is_integer(height) and height > 0 and
                    is_list(windows) and length(windows) == 4 and
                    Enum.all?(windows, fn
                      [x, y, patch_width, patch_height] ->
                        is_integer(x) and x >= 0 and is_integer(y) and y >= 0 and
                          is_integer(patch_width) and patch_width > 0 and
                          is_integer(patch_height) and patch_height > 0 and
                          x + patch_width <= width and y + patch_height <= height

                      _ ->
                        false
                    end)

                _ ->
                  false
              end)

            if valid_results? and
                 Enum.sort(Enum.map(results, & &1.version)) == Enum.to_list(1..40),
               do: {:ok, Map.put(batch, :catalog_id, catalog["id"])},
               else: :missing

          _ ->
            :missing
        end
      rescue
        ArgumentError -> :missing
      end
    else
      _ -> :missing
    end
  end

  def catalog(options \\ []) do
    directory = if options[:directory], do: directory(options[:directory]), else: directory()

    with {:ok, binary} <- File.read(Path.join(directory, "catalog.json")),
         {:ok,
          %{
            "schema" => 1,
            "payload" => @payload,
            "id" => id,
            "shards" => shards,
            "bodies" => bodies,
            "complete" => complete
          } = catalog} <- Jason.decode(binary),
         true <- is_binary(id) and Regex.match?(~r/\A[0-9a-f]{64}\z/, id),
         true <- is_list(shards) and is_list(bodies) and is_boolean(complete) do
      {:ok, catalog}
    else
      _ -> :missing
    end
  end

  def catalog_shard(namespace, name, options \\ []) do
    directory = if options[:directory], do: directory(options[:directory]), else: directory()

    with true <- namespace == Path.basename(directory),
         true <- Regex.match?(~r/\A[0-9a-f]{64}\.bin\z/, name),
         {:ok, _catalog} <- catalog(options),
         path = Path.join(directory, name),
         {:ok, %{type: :regular}} <- File.stat(path) do
      {:ok, %{path: path, sha256: String.trim_trailing(name, ".bin")}}
    else
      _ -> :missing
    end
  end

  def status(options \\ []) do
    directory = if options[:directory], do: directory(options[:directory]), else: directory()
    files = Path.wildcard(Path.join(directory, "*.etf"))

    total =
      Enum.reduce([:body, :eye_frame, :eye_ball], 1, fn category, total ->
        total * map_size(OpenQR.Engine.styles(category))
      end)

    %{
      directory: directory,
      completed: length(files),
      total: total,
      bytes: Enum.reduce(files, 0, fn path, bytes -> bytes + File.stat!(path).size end)
    }
  end

  def prebuild(options \\ []) do
    concurrency = Keyword.get(options, :concurrency, 4)
    limit = options[:limit]

    unless is_integer(concurrency) and concurrency > 0 and
             (is_nil(limit) or (is_integer(limit) and limit >= 0)) do
      raise ArgumentError,
            "Concurrency must be positive and the optional limit must be nonnegative."
    end

    directory = if options[:directory], do: directory(options[:directory]), else: directory()
    File.mkdir_p!(directory)
    baseline = %{body_shape: "rounded", eye_frame: "rounded-dots", eye_ball: "dots"}

    combinations =
      for body <- Map.keys(OpenQR.Engine.styles(:body)),
          frame <- Map.keys(OpenQR.Engine.styles(:eye_frame)),
          ball <- Map.keys(OpenQR.Engine.styles(:eye_ball)) do
        %{body_shape: body, eye_frame: frame, eye_ball: ball}
      end
      |> Enum.sort_by(fn styles ->
        {Enum.count(styles, fn {part, shape} -> shape != baseline[part] end), styles.body_shape,
         styles.eye_frame, styles.eye_ball}
      end)

    selected = Enum.take(combinations, limit || length(combinations))

    selected
    |> Task.async_stream(
      fn styles ->
        case fetch(styles, options) do
          {:ok, batch} ->
            {:reused, length(batch.skipped),
             if(batch.results == [], do: hd(batch.skipped).reason)}

          :missing ->
            {batch, failure} =
              case OpenQR.Engine.generate(@payload, @options ++ Map.to_list(styles)) do
                {:ok, batch} ->
                  {%{
                     results: Enum.map(batch.results, &Map.take(&1, @entry_keys)),
                     skipped: batch.skipped
                   }, nil}

                {:error, reason} ->
                  reason =
                    "The native batch returned no verified outputs. Batch error: " <> reason

                  {%{results: [], skipped: Enum.map(1..40, &%{version: &1, reason: reason})},
                   reason}
              end

            name =
              :crypto.hash(
                :sha256,
                :erlang.term_to_binary({styles.body_shape, styles.eye_frame, styles.eye_ball})
              )
              |> Base.encode16(case: :lower)

            path = Path.join(directory, name <> ".etf")
            temporary = path <> ".#{System.pid()}.#{System.unique_integer([:positive])}.tmp"

            encoded =
              :erlang.term_to_binary(
                {1, {styles.body_shape, styles.eye_frame, styles.eye_ball}, batch},
                [:compressed]
              )

            written =
              with :ok <- File.write(temporary, encoded), :ok <- File.rename(temporary, path) do
                {:built, length(batch.skipped), failure}
              else
                {:error, reason} ->
                  {:failed, 0, "Cannot cache #{inspect(styles)}: #{:file.format_error(reason)}"}
              end

            File.rm(temporary)
            written
        end
      end,
      max_concurrency: concurrency,
      ordered: false,
      timeout: :infinity
    )
    |> Enum.reduce(
      %{
        completed: 0,
        selected: length(selected),
        total: length(combinations),
        built: 0,
        reused: 0,
        failed: 0,
        skipped_versions: 0,
        failures: %{}
      },
      fn {:ok, {disposition, skipped, failure}}, summary ->
        summary = %{
          summary
          | completed: summary.completed + 1,
            skipped_versions: summary.skipped_versions + skipped
        }

        summary = Map.update!(summary, disposition, &(&1 + 1))

        summary =
          if failure do
            %{
              summary
              | failed: summary.failed + if(disposition == :failed, do: 0, else: 1),
                failures: Map.update(summary.failures, failure, 1, &(&1 + 1))
            }
          else
            summary
          end

        if callback = options[:progress], do: callback.(summary)
        summary
      end
    )
  end

  def catalog_status(options \\ []) do
    directory = if options[:directory], do: directory(options[:directory]), else: directory()

    case catalog(options) do
      {:ok, catalog} ->
        %{
          directory: directory,
          id: catalog["id"],
          combinations: catalog["combinations"],
          total_versions: catalog["total_versions"],
          available: catalog["available"],
          skipped: catalog["skipped"],
          evaluated: catalog["evaluated"],
          complete: catalog["complete"],
          bytes: Enum.sum(Enum.map(catalog["shards"], & &1["bytes"])),
          raw_bytes: Enum.sum(Enum.map(catalog["shards"], & &1["raw_bytes"]))
        }

      :missing ->
        %{directory: directory, id: nil, available: 0, skipped: 0, bytes: 0, raw_bytes: 0}
    end
  end

  def build_catalog(options \\ []) do
    directory = if options[:directory], do: directory(options[:directory]), else: directory()
    source = options[:source_directory] || directory
    limit = options[:limit]

    unless Path.type(source) == :absolute and
             (is_nil(limit) or (is_integer(limit) and limit >= 0)) do
      raise ArgumentError,
            "The source directory must be absolute and the optional limit must be nonnegative."
    end

    categories =
      Map.new([:body, :eye_frame, :eye_ball], fn category ->
        {category, OpenQR.Engine.styles(category) |> Map.keys() |> Enum.sort()}
      end)

    File.mkdir_p!(directory)

    staging =
      Path.join(directory, ".catalog-build-#{System.pid()}-#{System.unique_integer([:positive])}")

    File.mkdir_p!(Path.join(staging, "metadata"))
    File.mkdir_p!(Path.join(staging, "shards"))
    table = :ets.new(__MODULE__, [:set, :private])

    try do
      state = %{
        table: table,
        next_id: 0,
        shards: [],
        metadata: [],
        bodies: [],
        combinations: 0,
        evaluated: 0,
        available: 0,
        skipped: 0,
        body: nil
      }

      state =
        Enum.reduce(categories.body, state, fn body, state ->
          previous = state
          state = %{state | body: %{available: 0, skipped: 0, evaluated: 0, combinations: []}}

          {state, chunk} =
            for(frame <- categories.eye_frame, ball <- categories.eye_ball, do: {frame, ball})
            |> Enum.reduce(
              {state, %{planes: [], pixels: [], bytes: 0, combinations: [], windows: %{}}},
              fn {frame, ball}, {state, chunk} ->
                styles = %{body_shape: body, eye_frame: frame, eye_ball: ball}
                selected? = is_nil(limit) or state.combinations < limit

                batch =
                  if selected? do
                    case fetch(styles, source_directory: source) do
                      {:ok, batch} ->
                        batch

                      :missing ->
                        %{
                          results: [],
                          skipped:
                            Enum.map(
                              1..40,
                              &%{
                                version: &1,
                                reason: "Default preview source is missing or invalid."
                              }
                            )
                        }
                    end
                  else
                    %{
                      results: [],
                      skipped:
                        Enum.map(
                          1..40,
                          &%{
                            version: &1,
                            reason: "Catalog generation did not include this design."
                          }
                        )
                    }
                  end

                results = Map.new(batch.results, &{&1.version, &1})
                skipped = Map.new(batch.skipped, &{&1.version, &1.reason})

                {inspected, failures} =
                  Enum.reduce(1..40, {[], %{}}, fn version, {inspected, failures} ->
                    inspection =
                      if entry = results[version] do
                        case OpenQR.Engine.inspect_image(entry.preview, @payload) do
                          {:ok, %{verified: true} = image} ->
                            {:ok, entry, image}

                          {:ok, %{verified: false}} ->
                            {:skip,
                             "The delivered default preview could not be verified for the default payload."}

                          {:error, reason} ->
                            {:skip, "The delivered default preview is invalid: #{reason}"}
                        end
                      else
                        {:skip, skipped[version]}
                      end

                    case inspection do
                      {:ok, entry, image} ->
                        {[{entry, image} | inspected], failures}

                      {:skip, reason} ->
                        {inspected, Map.put(failures, version, reason)}
                    end
                  end)

                reliable? = map_size(failures) == 0
                available = length(inspected)
                failed = if selected?, do: map_size(failures), else: 0

                {state, chunk, metadata, versions} =
                  if reliable? do
                    Enum.reduce(
                      Enum.reverse(inspected),
                      {state, chunk, %{results: [], skipped: []}, []},
                      fn {entry, image}, {state, chunk, metadata, versions} ->
                        version = entry.version
                        {body_pixels, patches, windows} = decompose_preview(image, version)

                        {body_id, state, chunk} =
                          catalog_plane(
                            body_pixels,
                            image.width,
                            image.height,
                            windows,
                            state,
                            chunk
                          )

                        {patch_ids, {state, chunk}} =
                          Enum.map_reduce(Enum.zip(patches, windows), {state, chunk}, fn {pixels,
                                                                                          [
                                                                                            _x,
                                                                                            _y,
                                                                                            width,
                                                                                            height
                                                                                          ]},
                                                                                         {state,
                                                                                          chunk} ->
                            {id, state, chunk} =
                              catalog_plane(pixels, width, height, nil, state, chunk)

                            {id, {state, chunk}}
                          end)

                        refs = [body_id | patch_ids]

                        entry =
                          entry
                          |> Map.take(@entry_keys -- [:preview])
                          |> Map.merge(%{
                            raster_refs: refs,
                            width: image.width,
                            height: image.height,
                            windows: windows
                          })

                        metadata = %{metadata | results: [entry | metadata.results]}
                        chunk = %{chunk | windows: Map.put(chunk.windows, body_id, windows)}
                        {state, chunk, metadata, [refs | versions]}
                      end
                    )
                  else
                    skipped =
                      Enum.map(40..1//-1, fn version ->
                        %{
                          version: version,
                          reason:
                            failures[version] ||
                              "This design is unavailable because not all 40 delivered previews verified."
                        }
                      end)

                    {state, chunk, %{results: [], skipped: skipped}, List.duplicate(nil, 40)}
                  end

                metadata =
                  Map.merge(metadata, %{
                    results: Enum.reverse(metadata.results),
                    skipped: Enum.reverse(metadata.skipped),
                    reliability: %{
                      available: available,
                      skipped: failed,
                      reliable: reliable?,
                      evaluated: selected?
                    }
                  })

                encoded =
                  :erlang.term_to_binary({1, {body, frame, ball}, metadata}, [:compressed])

                name =
                  Base.encode16(
                    :crypto.hash(:sha256, :erlang.term_to_binary({body, frame, ball})),
                    case: :lower
                  ) <> ".etf"

                File.write!(Path.join([staging, "metadata", name]), encoded)

                combination = %{
                  frame: frame,
                  ball: ball,
                  versions: Enum.reverse(versions),
                  reliable: reliable?,
                  available: available,
                  skipped: failed,
                  evaluated: selected?
                }

                body_state = %{
                  state.body
                  | available: state.body.available + available,
                    skipped: state.body.skipped + failed,
                    evaluated: state.body.evaluated + if(selected?, do: 1, else: 0),
                    combinations: [combination | state.body.combinations]
                }

                state = %{
                  state
                  | combinations: state.combinations + 1,
                    evaluated: state.evaluated + if(selected?, do: 1, else: 0),
                    available: state.available + available,
                    skipped: state.skipped + failed,
                    body: body_state,
                    metadata: [{name, :crypto.hash(:sha256, encoded)} | state.metadata]
                }

                chunk = %{chunk | combinations: [combination | chunk.combinations]}

                {state, chunk} =
                  if chunk.bytes >= 16 * 1024 * 1024 do
                    write_catalog_shard(body, state, chunk, staging)
                  else
                    {state, chunk}
                  end

                if callback = options[:progress],
                  do: callback.(Map.take(state, [:combinations, :available, :skipped]))

                {state, chunk}
              end
            )

          state =
            if chunk.combinations == [],
              do: state,
              else: elem(write_catalog_shard(body, state, chunk, staging), 0)

          pairs =
            state.body.combinations
            |> Enum.filter(& &1.reliable)
            |> Enum.map(&[&1.frame, &1.ball])
            |> Enum.sort()

          complete? =
            state.body.evaluated == length(categories.eye_frame) * length(categories.eye_ball)

          retired? = complete? and (state.body.skipped > state.body.available or pairs == [])

          reason =
            cond do
              not complete? -> "incomplete-catalog"
              state.body.skipped > state.body.available -> "more-unreliable-previews"
              pairs == [] -> "no-complete-default"
              true -> nil
            end

          state =
            if retired? do
              :ets.select_delete(table, [
                {{:"$1", :"$2"}, [{:>=, :"$2", previous.next_id}], [true]}
              ])

              count = length(categories.eye_frame) * length(categories.eye_ball)

              metadata =
                Enum.take(state.metadata, count)
                |> Enum.map(fn {name, _hash} ->
                  path = Path.join([staging, "metadata", name])
                  {1, styles, batch} = :erlang.binary_to_term(File.read!(path), [:safe])

                  batch = %{
                    batch
                    | results: [],
                      skipped:
                        Enum.map(
                          1..40,
                          &%{
                            version: &1,
                            reason: "This body has no published default designs: #{reason}."
                          }
                        )
                  }

                  encoded = :erlang.term_to_binary({1, styles, batch}, [:compressed])
                  File.write!(path, encoded)
                  {name, :crypto.hash(:sha256, encoded)}
                end)

              state = %{
                state
                | next_id: previous.next_id,
                  shards: previous.shards,
                  metadata: metadata ++ Enum.drop(state.metadata, count)
              }

              combinations =
                Enum.map(
                  state.body.combinations,
                  &%{&1 | reliable: false, versions: List.duplicate(nil, 40)}
                )

              empty = %{
                planes: [],
                pixels: [],
                bytes: 0,
                combinations: combinations,
                windows: %{}
              }

              elem(write_catalog_shard(body, state, empty, staging), 0)
            else
              state
            end

          frames =
            Enum.map(categories.eye_frame, fn frame ->
              %{
                id: frame,
                reliable_combinations: Enum.count(pairs, fn [id, _] -> id == frame end)
              }
            end)

          balls =
            Enum.map(categories.eye_ball, fn ball ->
              %{id: ball, reliable_combinations: Enum.count(pairs, fn [_, id] -> id == ball end)}
            end)

          body_record = %{
            id: body,
            available: state.body.available,
            skipped: state.body.skipped,
            evaluated: state.body.evaluated,
            complete: complete?,
            retired: retired?,
            reason: reason,
            reliable_combinations: length(pairs),
            pairs: if(retired?, do: [], else: pairs),
            frames: frames,
            balls: balls
          }

          %{state | bodies: [body_record | state.bodies]}
        end)

      shards = Enum.reverse(state.shards)

      manifest = %{
        schema: 1,
        payload: @payload,
        shards: shards,
        bodies: Enum.reverse(state.bodies),
        combinations: state.combinations,
        evaluated: state.evaluated,
        complete: state.evaluated == state.combinations,
        unbuilt_versions: (state.combinations - state.evaluated) * 40,
        total_versions: state.combinations * 40,
        available: state.available,
        skipped: state.skipped
      }

      reliable_combinations =
        Enum.reduce(manifest.bodies, 0, fn body, count ->
          if body.retired, do: count, else: count + length(body.pairs)
        end)

      manifest =
        Map.merge(manifest, %{
          reliable_combinations: reliable_combinations,
          published_versions: reliable_combinations * 40
        })

      identity =
        :erlang.term_to_binary({manifest, Enum.reverse(state.metadata)}, [:deterministic])

      id = Base.encode16(:crypto.hash(:sha256, identity), case: :lower)
      manifest = Map.put(manifest, :id, id)

      Enum.each(shards, fn shard ->
        publish_catalog_file(
          Path.join([staging, "shards", shard.name]),
          Path.join(directory, shard.name)
        )
      end)

      metadata_directory = Path.join(directory, "catalog-#{id}")

      if File.dir?(metadata_directory) do
        Enum.each(state.metadata, fn {name, _hash} ->
          unless File.read!(Path.join(metadata_directory, name)) ==
                   File.read!(Path.join([staging, "metadata", name])) do
            raise "An immutable catalog metadata file has different contents: #{name}"
          end
        end)
      else
        File.rename!(Path.join(staging, "metadata"), metadata_directory)
      end

      temporary = Path.join(staging, "catalog.json")
      File.write!(temporary, Jason.encode!(manifest))
      File.rename!(temporary, Path.join(directory, "catalog.json"))
      Map.put(manifest, :directory, directory)
    after
      :ets.delete(table)
      File.rm_rf!(staging)
    end
  end

  defp decompose_preview(%{pixels: pixels, width: width, height: height}, version) do
    gray =
      for <<red, green, blue, alpha <- pixels>>, into: <<>> do
        unless red == green and green == blue and alpha == 255 do
          raise ArgumentError, "Default previews must have opaque grayscale pixels."
        end

        <<red>>
      end

    modules = 25 + 4 * version
    halo = if width == modules * 3 and height == modules * 3, do: 0, else: 3

    [[left, right], [top, bottom]] =
      Enum.map([width, height], fn side ->
        ratio = side / modules
        first = floor(4 * ratio) - halo
        last = ceil(11 * ratio) + halo
        opposite_first = floor((modules - 11) * ratio) - halo
        opposite_last = ceil((modules - 4) * ratio) + halo
        [[first, last - first], [opposite_first, opposite_last - opposite_first]]
      end)

    windows =
      for [x, patch_width] <- [left, right],
          [y, patch_height] <- [top, bottom],
          do: [x, y, patch_width, patch_height]

    [tl, bl, tr, br] = windows
    windows = [tl, tr, bl, br]

    patches =
      Enum.map(windows, fn [x, y, patch_width, patch_height] ->
        for row <- y..(y + patch_height - 1),
            into: <<>>,
            do: binary_part(gray, row * width + x, patch_width)
      end)

    runs =
      Enum.zip(windows, patches)
      |> Enum.flat_map(fn {[x, y, patch_width, patch_height], patch} ->
        for row <- 0..(patch_height - 1),
            do:
              {(y + row) * width + x, patch_width,
               binary_part(patch, row * patch_width, patch_width)}
      end)
      |> Enum.sort_by(&elem(&1, 0))

    {body, cursor} =
      Enum.reduce(runs, {[], 0}, fn {offset, length, _patch}, {parts, cursor} ->
        {[parts, binary_part(gray, cursor, offset - cursor), :binary.copy(<<255>>, length)],
         offset + length}
      end)

    body = IO.iodata_to_binary([body, binary_part(gray, cursor, byte_size(gray) - cursor)])

    {restored, cursor} =
      Enum.reduce(runs, {[], 0}, fn {offset, length, patch}, {parts, cursor} ->
        {[parts, binary_part(body, cursor, offset - cursor), patch], offset + length}
      end)

    unless IO.iodata_to_binary([restored, binary_part(body, cursor, byte_size(body) - cursor)]) ==
             gray do
      raise "Default preview raster reconstruction changed its pixels."
    end

    {body, patches, windows}
  end

  defp catalog_plane(pixels, width, height, windows, state, chunk) do
    key = {width, height, :crypto.hash(:sha256, pixels), windows}

    case :ets.lookup(state.table, key) do
      [{^key, id}] ->
        {id, state, chunk}

      [] ->
        id = state.next_id
        :ets.insert(state.table, {key, id})

        plane = %{
          id: id,
          width: width,
          height: height,
          offset: chunk.bytes,
          length: byte_size(pixels)
        }

        chunk = %{
          chunk
          | planes: [plane | chunk.planes],
            pixels: [pixels | chunk.pixels],
            bytes: chunk.bytes + byte_size(pixels)
        }

        {id, %{state | next_id: id + 1}, chunk}
    end
  end

  defp write_catalog_shard(body, state, chunk, staging) do
    header =
      Jason.encode!(%{
        body: body,
        planes: Enum.reverse(chunk.planes),
        combinations: Enum.reverse(chunk.combinations),
        windows: chunk.windows
      })

    raw =
      IO.iodata_to_binary([
        "OQR1",
        <<byte_size(header)::little-unsigned-32>>,
        header,
        Enum.reverse(chunk.pixels)
      ])

    compressed = :zlib.gzip(raw)
    sha256 = Base.encode16(:crypto.hash(:sha256, compressed), case: :lower)
    name = sha256 <> ".bin"
    path = Path.join([staging, "shards", name])
    File.write!(path, compressed)

    shard = %{
      name: name,
      sha256: sha256,
      bytes: byte_size(compressed),
      raw_bytes: byte_size(raw),
      raw_sha256: Base.encode16(:crypto.hash(:sha256, raw), case: :lower)
    }

    {%{state | shards: [shard | state.shards]},
     %{planes: [], pixels: [], bytes: 0, combinations: [], windows: %{}}}
  end

  defp publish_catalog_file(source, target) do
    case File.ln(source, target) do
      :ok ->
        :ok

      {:error, :eexist} ->
        unless File.read!(source) == File.read!(target),
          do: raise("An immutable catalog shard has different contents: #{Path.basename(target)}")

      {:error, reason} ->
        raise File.Error, reason: reason, action: "publish immutable catalog shard", path: target
    end
  end
end
