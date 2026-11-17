defmodule OpenQR.QRTest do
  use ExUnit.Case, async: true

  test "keeps a compatible design and replaces retired or incompatible choices" do
    settings =
      OpenQR.QR.changeset(%{"payload" => "Keep this draft"}) |> Ecto.Changeset.apply_changes()

    bodies = [
      %{
        "id" => "rounded",
        "retired" => false,
        "pairs" => [["square", "circle"], ["square", "square"], ["rounded", "square"]]
      },
      %{"id" => "circle", "retired" => false, "pairs" => [["rounded", "circle"]]},
      %{"id" => "star", "retired" => true, "pairs" => []}
    ]

    compatible = %{settings | eye_frame: "square", eye_ball: "square"}
    assert OpenQR.QR.reliable_design(compatible, bodies) == compatible

    assert %{
             body_shape: "rounded",
             eye_frame: "square",
             eye_ball: "circle",
             payload: "Keep this draft"
           } =
             OpenQR.QR.reliable_design(
               %{settings | body_shape: "star", eye_frame: "square", eye_ball: "dots"},
               bodies
             )

    assert %{eye_frame: "square", eye_ball: "square"} =
             OpenQR.QR.reliable_design(
               %{settings | eye_frame: "scalloped", eye_ball: "square"},
               bodies
             )

    assert %{body_shape: "circle", eye_frame: "rounded", eye_ball: "circle"} =
             OpenQR.QR.reliable_design(%{settings | body_shape: "circle"}, bodies)

    assert OpenQR.QR.reliable_design(settings, []) == settings
  end

  test "validates native options and retains literal payload text" do
    assert changeset = OpenQR.QR.changeset(%{"payload" => "  hello\nworld  "})
    assert changeset.valid?
    assert Ecto.Changeset.get_field(changeset, :payload) == "  hello\nworld  "
    assert Ecto.Changeset.get_field(changeset, :auto_brand)

    refute OpenQR.QR.changeset(%{"auto_brand" => "false"})
           |> Ecto.Changeset.get_field(:auto_brand)

    refute OpenQR.QR.changeset(%{"payload" => ""}).valid?
    refute OpenQR.QR.changeset().valid?

    empty = OpenQR.QR.changeset(%{"payload" => ""}) |> Ecto.Changeset.apply_changes()
    refute OpenQR.QR.changeset(%{"payload" => ""}, empty).valid?
    refute OpenQR.QR.changeset(%{"body_shape" => "missing"}).valid?
    refute OpenQR.QR.changeset(%{"background_color" => "invalid"}).valid?

    assert OpenQR.QR.changeset(%{
             "payload" => "A note",
             "background_color" => "rgb(24, 48, 72)",
             "background_transparent" => "false"
           }).valid?

    refute OpenQR.QR.changeset(%{
             "payload" => "A note",
             "background_color" => "rgb(24 48 72 / 0.5)",
             "background_transparent" => "false"
           }).valid?

    assert OpenQR.QR.changeset(%{
             "payload" => "A note",
             "eye_frame" => "follow-body",
             "eye_ball" => "follow-body"
           }).valid?
  end

  test "keeps omitted disabled settings when applying form changes" do
    settings =
      OpenQR.QR.changeset(%{"body_shape" => "diamond", "background_color" => "rgb(24, 48, 72)"})
      |> Ecto.Changeset.apply_changes()

    updated =
      OpenQR.QR.changeset(%{"mode" => "picture"}, settings) |> Ecto.Changeset.apply_changes()

    assert updated.body_shape == "diamond"
    assert updated.background_color == "rgb(24, 48, 72)"
  end

  test "chooses a verified export size when the preferred size cannot scan" do
    settings =
      OpenQR.QR.changeset(%{
        "payload" => "https://openqr.my",
        "auto_brand" => "false",
        "body_shape" => "rounded",
        "eye_frame" => "scalloped",
        "eye_ball" => "diamond"
      })
      |> Ecto.Changeset.apply_changes()

    assert {:error, "No verified layout" <> _} =
             OpenQR.QR.generate(settings, nil, nil, version: 1, seed: 42, scale: 12)

    assert {:ok, %{results: [entry]}} =
             OpenQR.QR.generate(settings, nil, nil, version: 1, seed: 42)

    assert {:ok, %{width: 174, height: 174, verified: true}} =
             OpenQR.Engine.inspect_image(entry.image, "https://openqr.my")
  end

  test "encodes the selected ha.mr link while preserving the entered website" do
    params = %{
      "payload" => "https://openqr.my",
      "auto_brand" => "false",
      "ha_mr" => "true",
      "ha_mr_url" => "https://ha.mr#.uod[;no"
    }

    changeset = OpenQR.QR.changeset(params)
    assert changeset.valid?
    settings = Ecto.Changeset.apply_changes(changeset)
    assert settings.payload == "https://openqr.my"

    assert {:ok, %{results: [entry]}} =
             OpenQR.QR.generate(settings, nil, nil, version: 4, seed: 42)

    assert entry.payload == "https://ha.mr#.uod[;no"
    assert entry.verified_frames == entry.total_frames

    refute OpenQR.QR.changeset(%{"ha_mr" => "true"}).valid?
    refute OpenQR.QR.changeset(%{"ha_mr" => "true", "ha_mr_url" => "https://example.com"}).valid?

    unchecked =
      OpenQR.QR.changeset(%{"ha_mr" => "false", "ha_mr_url" => ""}, settings)
      |> Ecto.Changeset.apply_changes()

    assert unchecked.payload == "https://openqr.my"
    refute unchecked.ha_mr
  end

  test "keeps the showcase at default content and options with only the selected shapes" do
    initial = OpenQR.QR.changeset() |> Ecto.Changeset.apply_changes()
    assert initial.payload == ""
    assert initial.auto_brand

    draft =
      OpenQR.QR.changeset(%{
        "payload" => "My own content",
        "mode" => "picture",
        "ha_mr" => "true",
        "ha_mr_url" => "https://ha.mr#CH",
        "auto_brand" => "true",
        "vary_url" => "true",
        "background_transparent" => "false",
        "background_color" => "#ff0000",
        "body_shape" => "circle",
        "eye_frame" => "follow-body",
        "eye_ball" => "circle",
        "scale" => "3",
        "color" => "false"
      })
      |> Ecto.Changeset.apply_changes()

    assert OpenQR.QR.showcase(draft) == %{
             initial
             | payload: "https://openqr.my",
               auto_brand: false,
               body_shape: "circle",
               eye_frame: "follow-body",
               eye_ball: "circle"
           }

    refute Map.has_key?(draft, :scale)
    refute Map.has_key?(draft, :color)
  end

  test "validates optional regeneration seeds without accepting error correction changes" do
    changeset = OpenQR.QR.regeneration_changeset(%{"seed" => ""})
    assert changeset.valid?
    assert Ecto.Changeset.get_field(changeset, :seed) == nil

    for seed <- ["0", "4294967295"] do
      assert OpenQR.QR.regeneration_changeset(%{"seed" => seed}).valid?
    end

    for seed <- ["-1", "4294967296", "not a seed"] do
      refute OpenQR.QR.regeneration_changeset(%{"seed" => seed}).valid?
    end

    changeset = OpenQR.QR.regeneration_changeset(%{"seed" => "42", "error_correction" => "L"})
    assert Ecto.Changeset.apply_changes(changeset) == %{seed: 42}
  end

  test "generates verified downloads through the native engine" do
    settings =
      OpenQR.QR.changeset(%{"payload" => "A handwritten note"}) |> Ecto.Changeset.apply_changes()

    assert {:ok, %{results: [entry]}} =
             OpenQR.QR.generate(settings, nil, nil, version: 4, seed: 42, error_correction: "M")

    assert entry.payload == "A handwritten note"
    assert entry.verified_frames == entry.total_frames
    assert entry.svg =~ "<svg"
    assert entry.error_correction == "M"
  end
end
