defmodule OpenQRWeb.IndexLive.Index do
  use OpenQRWeb, :live_view

  alias Ecto.Changeset
  alias OpenQR.DefaultQR
  alias OpenQR.QR

  @impl true
  def mount(_params, _session, socket) do
    changeset = QR.changeset()

    reliability =
      case DefaultQR.catalog() do
        {:ok, catalog} -> catalog["bodies"]
        :missing -> []
      end

    settings = QR.reliable_design(Changeset.apply_changes(changeset), reliability)

    changeset =
      Enum.reduce([:body_shape, :eye_frame, :eye_ball], changeset, fn field, changeset ->
        Changeset.put_change(changeset, field, settings[field])
      end)

    socket =
      socket
      |> assign(
        page_title: "OpenQR",
        active_tab: "generate",
        form: to_form(changeset, as: "qr"),
        catalog: QR.catalog(),
        reliability: reliability,
        designs_available?:
          reliability == [] || Enum.any?(reliability, &(!&1["retired"] && &1["pairs"] != [])),
        settings: settings,
        showcase?: true,
        gallery: nil,
        results: %{},
        skipped: %{},
        busy: false,
        generation_error: nil,
        selected_version: nil,
        selected_entry: nil,
        selected_busy: false,
        regeneration_form: nil,
        reference: nil,
        background: nil,
        reference_name: nil,
        background_name: nil
      )
      |> allow_upload(:reference,
        accept: ~w(.png .jpg .jpeg .webp .gif .ico),
        max_entries: 1,
        max_file_size: 10 * 1024 * 1024,
        auto_upload: true,
        progress: &handle_progress/3
      )
      |> allow_upload(:background,
        accept: ~w(.png .jpg .jpeg .webp .gif),
        max_entries: 1,
        max_file_size: 10 * 1024 * 1024,
        auto_upload: true,
        progress: &handle_progress/3
      )

    {:ok, generate_versions(socket)}
  end

  @impl true
  def handle_event("switch-tab", %{"tab" => tab}, socket)
      when tab in ["generate", "scan", "history"] do
    {:noreply,
     socket
     |> cancel_async(:selected)
     |> assign(
       active_tab: tab,
       selected_version: nil,
       selected_entry: nil,
       selected_busy: false,
       regeneration_form: nil
     )}
  end

  def handle_event(event, %{"qr" => params}, socket) when event in ["change", "generate"] do
    changeset = %{QR.changeset(params, socket.assigns.settings) | action: :validate}
    settings = QR.reliable_design(Changeset.apply_changes(changeset), socket.assigns.reliability)

    changeset =
      Enum.reduce([:body_shape, :eye_frame, :eye_ball], changeset, fn field, changeset ->
        Changeset.put_change(changeset, field, settings[field])
      end)

    socket = assign(socket, form: to_form(changeset, as: "qr"), settings: settings)

    cond do
      event == "generate" and settings.mode == "mosaic" and not socket.assigns.designs_available? ->
        {:noreply,
         assign(socket,
           generation_error: "No reliable designs are available in the prepared catalog."
         )}

      event == "generate" and changeset.valid? ->
        {:noreply, socket |> assign(showcase?: false) |> generate_versions()}

      event == "generate" ->
        {:noreply, assign(socket, generation_error: "Check the highlighted settings.")}

      true ->
        {:noreply, socket}
    end
  end

  def handle_event("showcase-ready", %{"catalog_id" => id}, socket) do
    case {socket.assigns.showcase?, DefaultQR.catalog()} do
      {true, {:ok, %{"id" => ^id, "bodies" => bodies}}} ->
        {:noreply,
         assign(socket,
           reliability: bodies,
           designs_available?: Enum.any?(bodies, &(!&1["retired"] && &1["pairs"] != []))
         )}

      _ ->
        {:noreply, socket}
    end
  end

  def handle_event("select-version", _params, %{assigns: %{busy: true}} = socket) do
    {:noreply, socket}
  end

  def handle_event("select-version", %{"version" => value} = params, socket) do
    socket =
      if socket.assigns.showcase? do
        settings =
          socket.assigns.settings
          |> Map.merge(%{
            body_shape: Map.get(params, "body", socket.assigns.settings.body_shape),
            eye_frame: Map.get(params, "frame", socket.assigns.settings.eye_frame),
            eye_ball: Map.get(params, "ball", socket.assigns.settings.eye_ball)
          })
          |> QR.showcase()

        case DefaultQR.showcase(settings) do
          {:ok, batch} ->
            socket
            |> assign(gallery: %{settings: settings, reference: nil, background: nil})
            |> present_versions(batch)

          :missing ->
            assign(socket, results: %{}, generation_error: "This default preview is unavailable.")
        end
      else
        socket
      end

    with {version, ""} <- Integer.parse(value),
         entry when not is_nil(entry) <- socket.assigns.results[version] do
      {:noreply,
       socket
       |> assign(
         selected_version: version,
         selected_entry: entry,
         regeneration_form: to_form(QR.regeneration_changeset(), as: "version")
       )
       |> generate_selected()}
    else
      _ -> {:noreply, socket}
    end
  end

  def handle_event("close-version", _params, socket) do
    {:noreply,
     socket
     |> cancel_async(:selected)
     |> assign(
       selected_version: nil,
       selected_entry: nil,
       selected_busy: false,
       regeneration_form: nil
     )}
  end

  def handle_event(event, %{"version" => params}, %{assigns: %{selected_entry: entry}} = socket)
      when event in ["change-regeneration", "regenerate"] and not is_nil(entry) do
    changeset = %{QR.regeneration_changeset(params) | action: :validate}
    socket = assign(socket, regeneration_form: to_form(changeset, as: "version"))

    if event == "regenerate" and changeset.valid? do
      regeneration = Changeset.apply_changes(changeset)

      {:noreply,
       generate_selected(socket,
         seed: regeneration.seed || entry.seed,
         randomize_seed: is_nil(regeneration.seed)
       )}
    else
      {:noreply, socket}
    end
  end

  def handle_event(event, _params, socket) when event in ["change-regeneration", "regenerate"] do
    {:noreply, socket}
  end

  def handle_event("remove-image", %{"image" => image}, socket)
      when image in ["reference", "background"] do
    socket =
      case image do
        "reference" ->
          assign(socket, reference: nil, reference_name: nil)

        "background" ->
          assign(socket, background: nil, background_name: nil)
      end

    {:noreply, socket}
  end

  def handle_event("cancel_upload", %{"ref" => ref}, socket) do
    socket =
      Enum.reduce([:reference, :background], socket, fn name, socket ->
        if Enum.any?(socket.assigns.uploads[name].entries, &(&1.ref == ref)) do
          cancel_upload(socket, name, ref)
        else
          socket
        end
      end)

    {:noreply, socket}
  end

  def handle_progress(name, entry, socket) do
    if entry.done? do
      bytes =
        consume_uploaded_entry(socket, entry, fn %{path: path} -> {:ok, File.read!(path)} end)

      other = if name == :reference, do: socket.assigns.background, else: socket.assigns.reference

      if byte_size(bytes) + byte_size(other || "") > 10 * 1024 * 1024 do
        {:noreply, assign(socket, generation_error: "Combined images must be under 10 MB.")}
      else
        socket =
          case name do
            :reference -> assign(socket, reference: bytes, reference_name: entry.client_name)
            :background -> assign(socket, background: bytes, background_name: entry.client_name)
          end

        {:noreply, socket}
      end
    else
      {:noreply, socket}
    end
  end

  @impl true
  def handle_async(:versions, _result, %{assigns: %{busy: false}} = socket) do
    {:noreply, socket}
  end

  def handle_async(:selected, _result, %{assigns: %{selected_entry: nil}} = socket) do
    {:noreply, socket}
  end

  def handle_async(:versions, {:ok, {:ok, batch}}, socket) do
    {:noreply, present_versions(socket, batch)}
  end

  def handle_async(:versions, {:ok, {:error, reason}}, socket) do
    {:noreply,
     assign(socket,
       busy: false,
       results: %{},
       skipped: %{},
       selected_entry: nil,
       selected_version: nil,
       selected_busy: false,
       generation_error: reason
     )}
  end

  def handle_async(:selected, {:ok, {:ok, %{results: [entry | _]}}}, socket) do
    socket = assign(socket, selected_entry: entry, selected_busy: false, generation_error: nil)

    socket =
      if socket.assigns.showcase? do
        socket
      else
        update(
          socket,
          :results,
          &Map.put(
            &1,
            entry.version,
            Map.drop(entry, [:image, :svg, :target_preview, :block_errors, :block_capacities])
          )
        )
      end

    {:noreply, socket}
  end

  def handle_async(:selected, {:ok, {:error, reason}}, socket) do
    {:noreply, assign(socket, selected_busy: false, generation_error: reason)}
  end

  def handle_async(name, {:exit, reason}, socket) when name in [:versions, :selected] do
    if reason in [:normal, :shutdown] or match?({:shutdown, _}, reason) do
      {:noreply, socket}
    else
      {:noreply,
       assign(socket,
         busy: false,
         selected_busy: false,
         generation_error: "Generation stopped. Try again or choose a different design."
       )}
    end
  end

  defp generate_versions(socket) do
    gallery =
      if socket.assigns.showcase? do
        %{settings: QR.showcase(socket.assigns.settings), reference: nil, background: nil}
      else
        %{
          settings: socket.assigns.settings,
          reference: socket.assigns.reference,
          background: socket.assigns.background
        }
      end

    socket =
      socket
      |> cancel_async(:versions)
      |> cancel_async(:selected)
      |> assign(
        gallery: gallery,
        generation_error: nil,
        selected_busy: false,
        selected_entry: nil,
        selected_version: nil,
        regeneration_form: nil
      )

    cached =
      if socket.assigns.showcase? do
        DefaultQR.showcase(gallery.settings)
      else
        :missing
      end

    case cached do
      {:ok, batch} ->
        present_versions(socket, batch)

      :missing ->
        cond do
          socket.assigns.showcase? ->
            assign(socket,
              busy: false,
              results: %{},
              skipped: %{}
            )

          connected?(socket) ->
            socket
            |> assign(busy: true)
            |> start_async(:versions, fn ->
              QR.generate(gallery.settings, gallery.reference, gallery.background,
                scale: 3,
                randomize_seed: true
              )
            end)

          true ->
            assign(socket, busy: true)
        end
    end
  end

  defp present_versions(socket, batch) do
    results =
      Map.new(
        batch.results,
        &{&1.version,
         Map.drop(&1, [:image, :svg, :target_preview, :block_errors, :block_capacities])}
      )

    skipped = Map.new(batch.skipped, &{&1.version, &1.reason})

    assign(socket,
      results: results,
      skipped: skipped,
      busy: false,
      gallery: %{
        socket.assigns.gallery
        | reference: Map.get(batch, :source_reference, socket.assigns.gallery.reference)
      },
      generation_error: nil
    )
  end

  defp generate_selected(socket, overrides \\ []) do
    gallery = socket.assigns.gallery

    options =
      Keyword.merge(
        [
          version: socket.assigns.selected_version,
          seed: socket.assigns.selected_entry.seed
        ],
        overrides
      )

    socket
    |> cancel_async(:selected)
    |> assign(selected_busy: true, generation_error: nil)
    |> start_async(:selected, fn ->
      QR.generate(gallery.settings, gallery.reference, gallery.background, options)
    end)
  end
end
