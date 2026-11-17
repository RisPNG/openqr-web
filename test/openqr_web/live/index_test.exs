defmodule OpenQRWeb.IndexLiveTest do
  use OpenQRWeb.ConnCase, async: false

  import Phoenix.LiveViewTest

  test "switches tools without generating or losing the editor draft", %{conn: conn} do
    {:ok, view, _} = live(conn, ~p"/")
    render_async(view, 30_000)
    initial = gallery_previews(view)
    view |> form("#qr-options", qr: %{payload: "A draft to keep"}) |> render_change()

    view |> element("#qr-tab-scan") |> render_click()
    assert has_element?(view, "#qr-tab-scan[aria-current='page']")
    assert has_element?(view, "#qr-generate-panel[hidden]")
    assert has_element?(view, "#qr-scanner[phx-hook='QRScanner']")
    assert has_element?(view, "#scan-file:not([phx-hook])")
    assert has_element?(view, "#qr-history-panel[hidden]")
    assert gallery_previews(view) == initial

    view |> element("#qr-tab-history") |> render_click()
    refute has_element?(view, "#qr-scanner")
    assert has_element?(view, "#qr-history-panel:not([hidden])")
    assert has_element?(view, "#qr-history[phx-update='ignore']")
    assert has_element?(view, "[data-history-status]", "No downloads yet")

    view |> element("#qr-tab-generate") |> render_click()
    assert has_element?(view, "#qr-generate-panel:not([hidden])")
    assert has_element?(view, "textarea[name='qr[payload]']", "A draft to keep")
    assert gallery_previews(view) == initial
  end

  test "accepts readiness only for the current catalog while the showcase is active" do
    {:ok, catalog} = OpenQR.DefaultQR.catalog()

    socket =
      %Phoenix.LiveView.Socket{}
      |> Phoenix.Component.assign(showcase?: true, reliability: [], designs_available?: false)

    assert {:noreply, ready} =
             OpenQRWeb.IndexLive.Index.handle_event(
               "showcase-ready",
               %{"catalog_id" => catalog["id"]},
               socket
             )

    assert ready.assigns.reliability == catalog["bodies"]
    assert ready.assigns.designs_available?

    assert {:noreply, ^socket} =
             OpenQRWeb.IndexLive.Index.handle_event(
               "showcase-ready",
               %{"catalog_id" => "obsolete"},
               socket
             )

    generated = Phoenix.Component.assign(socket, showcase?: false)

    assert {:noreply, ^generated} =
             OpenQRWeb.IndexLive.Index.handle_event(
               "showcase-ready",
               %{"catalog_id" => catalog["id"]},
               generated
             )
  end

  @image Base.decode64!(
           "iVBORw0KGgoAAAANSUhEUgAAAAYAAAAFCAYAAABmWJ3mAAAAHklEQVR4nGMUMYr6zwAFb84tY4SxmWAMdIBTgnQAAM/bBAZ/BQtiAAAAAElFTkSuQmCC"
         )

  setup_all do
    OpenQR.DefaultQR.prebuild(limit: 1, concurrency: 1)

    styles = %{body_shape: "circle", eye_frame: "rounded-dots", eye_ball: "dots"}

    if OpenQR.DefaultQR.fetch(styles) == :missing do
      {:ok, batch} =
        OpenQR.Engine.generate("https://openqr.my",
          version: 0,
          scale: 3,
          seed: 42,
          color: true,
          mode: :mosaic,
          vary_url: false,
          body_shape: styles.body_shape,
          eye_frame: styles.eye_frame,
          eye_ball: styles.eye_ball
        )

      results =
        Enum.map(batch.results, fn entry ->
          Map.take(
            entry,
            ~w(version seed preview format payload verified_frames total_frames error_correction)a
          )
        end)

      name =
        :crypto.hash(:sha256, :erlang.term_to_binary({"circle", "rounded-dots", "dots"}))
        |> Base.encode16(case: :lower)

      File.write!(
        Path.join(OpenQR.DefaultQR.directory(), name <> ".etf"),
        :erlang.term_to_binary(
          {1, {"circle", "rounded-dots", "dots"}, %{results: results, skipped: batch.skipped}},
          [:compressed]
        )
      )
    end

    batches =
      Enum.map(["rounded", "circle"], fn body ->
        styles = %{body_shape: body, eye_frame: "rounded-dots", eye_ball: "dots"}
        {:ok, batch} = OpenQR.DefaultQR.fetch(styles)

        results =
          Enum.map(batch.results, fn entry ->
            {:ok, image} = OpenQR.Engine.inspect_image(entry.preview, "https://openqr.my")

            entry
            |> Map.delete(:preview)
            |> Map.merge(%{
              raster_refs: [0, 1, 1, 1, 1],
              width: image.width,
              height: image.height,
              windows: List.duplicate([0, 0, 1, 1], 4)
            })
          end)

        {body, %{batch | results: results}}
      end)

    id = Base.encode16(:crypto.hash(:sha256, :erlang.term_to_binary(batches)), case: :lower)
    directory = OpenQR.DefaultQR.directory()
    File.mkdir_p!(Path.join(directory, "catalog-#{id}"))

    for {body, batch} <- batches do
      name =
        Base.encode16(
          :crypto.hash(:sha256, :erlang.term_to_binary({body, "rounded-dots", "dots"})),
          case: :lower
        )

      File.write!(
        Path.join([directory, "catalog-#{id}", name <> ".etf"]),
        :erlang.term_to_binary({1, {body, "rounded-dots", "dots"}, batch}, [:compressed])
      )
    end

    File.write!(
      Path.join(directory, "catalog.json"),
      Jason.encode!(%{
        schema: 1,
        payload: "https://openqr.my",
        id: id,
        complete: true,
        combinations: 2,
        total_versions: 80,
        available: 80,
        skipped: 0,
        shards: [],
        bodies:
          Enum.map(batches, fn {body, _} ->
            %{id: body, retired: false, pairs: [["rounded-dots", "dots"]]}
          end)
      })
    )

    :ok
  end

  test "opens with an empty input, forty showcase versions, and branded footer", %{conn: conn} do
    {:ok, view, html} = live(conn, ~p"/")
    document = Floki.parse_document!(html)

    assert document |> Floki.find("title") |> Floki.text() |> String.trim() == "OpenQR"
    assert has_element?(view, "main#main-content")
    assert has_element?(view, "#qr-editor")
    assert has_element?(view, "#gallery-title", "Design showcase")
    assert length(Floki.find(document, "#qr-gallery [data-showcase-version]")) == 40
    assert length(Floki.find(document, "#qr-gallery canvas")) == 40
    assert length(Floki.find(document, "#qr-gallery [data-showcase-version][disabled]")) == 40
    assert has_element?(view, "#qr-design-options[phx-hook='QRDesign']")

    assert has_element?(
             view,
             "textarea[name='qr[payload]'][placeholder='https://example.com']"
           )

    assert document |> Floki.find("textarea[name='qr[payload]']") |> Floki.text() == ""
    assert has_element?(view, "input[name='qr[auto_brand]'][type='checkbox'][checked]")
    refute has_element?(view, "#version-card")
    refute has_element?(view, "#qr-export-options")

    for field <- ~w(scale recovery_margin contrast brightness color) do
      refute has_element?(view, "[name='qr[#{field}]']")
    end

    assert has_element?(view, "footer", "Powered by")

    assert has_element?(
             view,
             "footer a[href='https://github.com/rispng/openqr']",
             "OpenQR Engine"
           )

    assert has_element?(view, "header .qr-byline", "by Ris Peng")
    assert has_element?(view, "header .qr-byline a[href='https://rispeng.com']", "Ris Peng")

    assert has_element?(
             view,
             "footer a[href='https://poppybit.com'][aria-label='Poppybit']",
             "Poppybit"
           )

    assert has_element?(
             view,
             "footer a[href='https://poppybit.com'] img[src='/images/poppybit.png']"
           )
  end

  test "recovers when a missing showcase catalog becomes available", %{conn: conn} do
    manifest_path = Path.join(OpenQR.DefaultQR.directory(), "catalog.json")
    manifest = File.read!(manifest_path)
    {:ok, catalog} = OpenQR.DefaultQR.catalog()
    on_exit(fn -> File.write!(manifest_path, manifest) end)
    File.rm!(manifest_path)

    {:ok, view, _} = live(conn, ~p"/")
    assert has_element?(view, "#qr-showcase[phx-hook='QRShowcase']")
    assert has_element?(view, "[data-showcase-retry]")
    refute has_element?(view, "#generation-error")

    File.write!(manifest_path, manifest)
    render_hook(view, "showcase-ready", %{"catalog_id" => catalog["id"]})
    render_click(view, "select-version", %{"version" => "4"})
    render_async(view, 30_000)
    assert has_element?(view, "a[download='openqr-v4.png']")
    refute has_element?(view, "#generation-error")

    view |> element("button[phx-click='close-version']") |> render_click()
    view |> form("#qr-options", qr: %{payload: ""}) |> render_submit()
    assert has_element?(view, "#generation-error", "Check the highlighted settings.")
    render_hook(view, "showcase-ready", %{"catalog_id" => catalog["id"]})
    assert has_element?(view, "#generation-error", "Check the highlighted settings.")
  end

  test "showcases only shape changes while input, options, and uploads wait for generation", %{
    conn: conn
  } do
    {:ok, view, _} = live(conn, ~p"/")
    initial = gallery_previews(view)

    view |> form("#qr-options", qr: %{payload: ""}) |> render_submit()
    assert has_element?(view, "#generation-error", "Check the highlighted settings")
    assert has_element?(view, "#gallery-title", "Design showcase")
    assert gallery_previews(view) == initial

    for params <- [
          %{payload: "This draft is not encoded"},
          %{vary_url: "true", auto_brand: "true", ha_mr: "true"},
          %{background_transparent: "false"},
          %{mode: "picture"},
          %{mode: "mosaic"}
        ] do
      view |> form("#qr-options", qr: params) |> render_change()
      render_async(view, 30_000)
      assert gallery_previews(view) == initial
      assert has_element?(view, "#qr-gallery[aria-busy='false']")
      assert has_element?(view, "#qr-gallery [data-showcase-version][disabled]")
    end

    upload =
      file_input(view, "#qr-options", :reference, [
        %{name: "reference.png", content: @image, type: "image/png"}
      ])

    render_upload(upload, "reference.png")
    render_async(view, 30_000)
    assert has_element?(view, "#qr-options", "reference.png")
    assert gallery_previews(view) == initial

    render_change(view, "change", %{"qr" => %{"body_shape" => "circle"}})
    render_async(view, 30_000)
    assert gallery_previews(view) == initial
    assert has_element?(view, "#qr-showcase[phx-update='ignore'][phx-hook='QRShowcase']")
    assert has_element?(view, "input[name='qr[body_shape]'][value='circle'][checked]")
    assert has_element?(view, "#gallery-title", "Design showcase")

    render_click(view, "select-version", %{
      "version" => "4",
      "body" => "circle",
      "frame" => "rounded-dots",
      "ball" => "dots"
    })

    render_async(view, 30_000)
    assert has_element?(view, "#version-card", "https://openqr.my")
    refute has_element?(view, "#version-card", "This draft is not encoded")
    assert has_element?(view, "a[download='openqr-v4.svg']")

    view |> element("button[phx-click='close-version']") |> render_click()
    before_removal = gallery_previews(view)

    view
    |> element("button[phx-click='remove-image'][phx-value-image='reference']")
    |> render_click()

    render_async(view, 30_000)
    assert gallery_previews(view) == before_removal
  end

  test "opens verified downloads and supports blank, fixed, and invalid regeneration seeds", %{
    conn: conn
  } do
    {:ok, view, _} = live(conn, ~p"/")
    render_click(view, "select-version", %{"version" => "4"})
    render_async(view, 30_000)

    assert has_element?(
             view,
             "#version-modal [role='dialog'][aria-modal='true'][aria-label='Version 4']"
           )

    downloads = view |> render() |> Floki.parse_document!()

    assert downloads
           |> Floki.find("a[download='openqr-v4.png']")
           |> Floki.attribute("data-download-content")
           |> hd()
           |> Base.decode64!()
           |> binary_part(0, 8) == <<137, 80, 78, 71, 13, 10, 26, 10>>

    assert download_svg(view) |> Base.decode64!() |> Floki.parse_document!() |> Floki.find("svg") !=
             []

    seed_value =
      downloads
      |> Floki.find("input[name='version[seed]']")
      |> Floki.attribute("value")
      |> List.first()

    assert seed_value in [nil, ""]

    first_seed = seed_placeholder(view)

    view |> form("#qr-regeneration", version: %{seed: ""}) |> render_submit()
    render_async(view, 30_000)
    second_seed = seed_placeholder(view)
    refute second_seed == first_seed

    view |> form("#qr-regeneration", version: %{seed: ""}) |> render_submit()
    render_async(view, 30_000)
    third_seed = seed_placeholder(view)
    refute third_seed == second_seed
    refute has_element?(view, "input[name='version[seed]'][value]:not([value=''])")

    view |> form("#qr-regeneration", version: %{seed: "-1"}) |> render_submit()
    assert has_element?(view, "#qr-regeneration", "must be greater than or equal to 0")
    assert seed_placeholder(view) == third_seed
    assert has_element?(view, "a[download='openqr-v4.png']")

    refute has_element?(view, "[name='version[error_correction]']")

    view |> form("#qr-regeneration", version: %{seed: "0"}) |> render_submit()
    render_async(view, 30_000)
    assert seed_placeholder(view) == 0
    assert has_element?(view, "input[name='version[seed]'][value='0']")
    fixed_download = download_svg(view)

    render_submit(view, "regenerate", %{
      "version" => %{"seed" => "0", "error_correction" => "L"}
    })

    render_async(view, 30_000)
    assert download_svg(view) == fixed_download

    view |> form("#qr-regeneration", version: %{seed: "1234"}) |> render_submit()
    render_async(view, 30_000)
    assert seed_placeholder(view) == 1234
    assert has_element?(view, "input[name='version[seed]'][value='1234']")

    view |> element("button[phx-click='close-version']") |> render_click()
    refute has_element?(view, "#version-modal")
    refute has_element?(view, "#version-card")
  end

  test "keeps the generated content and design until edited content is explicitly submitted", %{
    conn: conn
  } do
    {:ok, view, _} = live(conn, ~p"/")
    initial = gallery_previews(view)

    view |> form("#qr-options", qr: %{payload: "A note for tomorrow"}) |> render_change()
    assert gallery_previews(view) == initial
    view |> form("#qr-options") |> render_submit()
    render_async(view, 30_000)
    assert has_element?(view, "#gallery-title", "Choose a version")

    render_click(view, "select-version", %{"version" => "4"})
    render_async(view, 30_000)
    assert has_element?(view, "#version-card", "A note for tomorrow")
    generated_svg = download_svg(view)
    view |> element("button[phx-click='close-version']") |> render_click()
    generated = gallery_previews(view)

    view
    |> form("#qr-options",
      qr: %{
        payload: "https://openqr.my",
        auto_brand: "false",
        body_shape: "circle",
        ha_mr: "true"
      }
    )
    |> render_change(%{qr: %{ha_mr_url: "https://ha.mr#.uod[;no"}})

    render_async(view, 30_000)
    assert gallery_previews(view) == generated
    assert has_element?(view, "textarea[name='qr[payload]']", "https://openqr.my")

    upload =
      file_input(view, "#qr-options", :background, [
        %{name: "background.png", content: @image, type: "image/png"}
      ])

    render_upload(upload, "background.png")
    render_async(view, 30_000)
    assert gallery_previews(view) == generated

    render_click(view, "select-version", %{"version" => "4"})
    render_async(view, 30_000)
    assert has_element?(view, "#version-card", "A note for tomorrow")
    assert download_svg(view) == generated_svg

    view
    |> form("#qr-regeneration", version: %{seed: to_string(seed_placeholder(view))})
    |> render_submit()

    render_async(view, 30_000)
    assert download_svg(view) == generated_svg
    view |> element("button[phx-click='close-version']") |> render_click()

    view
    |> element("button[phx-click='remove-image'][phx-value-image='background']")
    |> render_click()

    assert gallery_previews(view) == generated

    view |> form("#qr-options") |> render_submit()
    render_async(view, 30_000)
    refute gallery_previews(view) == generated
    render_click(view, "select-version", %{"version" => "4"})
    render_async(view, 30_000)
    assert has_element?(view, "#version-card", "https://ha.mr#.uod[;no")
    refute has_element?(view, "#version-card", "A note for tomorrow")

    view |> element("button[phx-click='close-version']") |> render_click()
    compressed = gallery_previews(view)

    view
    |> form("#qr-options", qr: %{ha_mr: "false", payload: ""})
    |> render_change(%{qr: %{ha_mr_url: ""}})

    render_async(view, 30_000)
    assert gallery_previews(view) == compressed
    render_click(view, "select-version", %{"version" => "4"})
    render_async(view, 30_000)
    assert has_element?(view, "#version-card", "https://ha.mr#.uod[;no")
  end

  test "can cancel a pending reference image", %{conn: conn} do
    {:ok, view, _} = live(conn, ~p"/")

    upload =
      file_input(view, "#qr-options", :reference, [
        %{name: "reference.png", content: @image, type: "image/png"}
      ])

    render_upload(upload, "reference.png", 10)
    view |> element("button[phx-click='cancel_upload']") |> render_click()
    refute has_element?(view, "button[phx-click='cancel_upload']")
  end

  test "ignores completed work queued after a modal closes or a cached gallery replaces it" do
    {:ok, batch} =
      OpenQR.DefaultQR.fetch(%{
        body_shape: "rounded",
        eye_frame: "rounded-dots",
        eye_ball: "dots"
      })

    socket =
      Phoenix.Component.assign(%Phoenix.LiveView.Socket{},
        busy: false,
        selected_entry: nil,
        selected_version: nil,
        selected_busy: false,
        results: %{},
        skipped: %{},
        generation_error: nil
      )

    assert {:noreply, ^socket} =
             OpenQRWeb.IndexLive.Index.handle_async(:selected, {:ok, {:ok, batch}}, socket)

    assert {:noreply, ^socket} =
             OpenQRWeb.IndexLive.Index.handle_async(
               :selected,
               {:ok, {:error, "Cancelled"}},
               socket
             )

    assert {:noreply, ^socket} =
             OpenQRWeb.IndexLive.Index.handle_async(:versions, {:ok, {:ok, batch}}, socket)

    generating =
      Phoenix.Component.assign(socket,
        busy: true,
        results: Map.new(batch.results, &{&1.version, &1})
      )

    assert {:noreply, ^generating} =
             OpenQRWeb.IndexLive.Index.handle_event(
               "select-version",
               %{"version" => "4"},
               generating
             )
  end

  defp gallery_previews(view) do
    view
    |> element("#qr-gallery")
    |> render()
    |> Floki.parse_document!()
    |> Floki.find("img")
    |> Floki.attribute("src")
    |> Enum.map(&:crypto.hash(:sha256, &1))
  end

  defp seed_placeholder(view) do
    view
    |> render()
    |> Floki.parse_document!()
    |> Floki.find("input[name='version[seed]']")
    |> Floki.attribute("placeholder")
    |> hd()
    |> String.to_integer()
  end

  defp download_svg(view) do
    view
    |> render()
    |> Floki.parse_document!()
    |> Floki.find("a[download='openqr-v4.svg']")
    |> Floki.attribute("data-download-content")
    |> hd()
  end
end
