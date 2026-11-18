defmodule OpenQR.QR do
  alias Ecto.Changeset
  alias OpenQR.CoreUtils.Parse

  @defaults Map.merge(Application.compile_env!(:openqr, :default_qr_design), %{
              payload: "",
              mode: "mosaic",
              auto_brand: true,
              vary_url: false,
              ha_mr: false,
              ha_mr_url: "",
              background_transparent: true,
              background_color: "#000000"
            })

  @output_options [scale: 12, recovery_margin: 2, contrast: 1.0, brightness: 1.0, color: true]
  @showcase_payload Application.compile_env!(:openqr, :default_qr_payload)

  @types Map.new(@defaults, fn {key, value} ->
           {key, if(is_boolean(value), do: :boolean, else: :string)}
         end)

  def changeset(params \\ %{}, settings \\ @defaults) do
    changeset =
      {settings, @types}
      |> Changeset.cast(params, Map.keys(@types), empty_values: [])

    changeset =
      changeset
      |> Changeset.force_change(:payload, Changeset.get_field(changeset, :payload))
      |> Changeset.validate_required([:payload])
      |> Changeset.validate_length(:payload, min: 1, max: 10_000)
      |> Changeset.validate_inclusion(:mode, ["mosaic", "picture"])

    changeset =
      if Changeset.get_field(changeset, :ha_mr) and
           !Regex.match?(
             ~r/\Ahttps:\/\/ha\.mr#[^\s]+\z/,
             Changeset.get_field(changeset, :ha_mr_url) || ""
           ) do
        Changeset.add_error(
          changeset,
          :ha_mr,
          "Use a valid website address without a username or password."
        )
      else
        changeset
      end

    changeset =
      case Parse.inspect_color(Changeset.get_field(changeset, :background_color)) do
        {:ok, %{rgba: %{a: alpha}}} when alpha == 1 ->
          changeset

        {:ok, %{rgba: _}} ->
          if Changeset.get_field(changeset, :background_transparent) do
            changeset
          else
            Changeset.add_error(
              changeset,
              :background_color,
              "must be opaque; use the transparency option for a transparent background"
            )
          end

        _ ->
          Changeset.add_error(changeset, :background_color, "must be a supported color")
      end

    Enum.reduce([body_shape: :body, eye_frame: :eye_frame, eye_ball: :eye_ball], changeset, fn
      {field, category}, changeset ->
        Changeset.validate_inclusion(changeset, field, Map.keys(OpenQR.Engine.styles(category)))
    end)
  end

  def catalog do
    Map.new([body: :body_shape, eye_frame: :eye_frame, eye_ball: :eye_ball], fn {category, field} ->
      choices =
        category
        |> OpenQR.Engine.styles()
        |> Enum.sort_by(fn {id, label} -> {id != "follow-body", label} end)
        |> Enum.map(fn {id, label} ->
          {:ok, preview} = OpenQR.Engine.style_preview(category, id)
          %{id: id, label: label, preview: preview}
        end)

      {field, choices}
    end)
  end

  def showcase(settings) do
    %{
      @defaults
      | payload: @showcase_payload,
        auto_brand: false,
        body_shape: settings.body_shape,
        eye_frame: settings.eye_frame,
        eye_ball: settings.eye_ball
    }
  end

  def reliable_design(settings, bodies) do
    available = Enum.filter(bodies, &(!&1["retired"] && &1["pairs"] != []))

    case Enum.find(available, &(&1["id"] == settings.body_shape)) || List.first(available) do
      nil ->
        settings

      body ->
        [frame, ball] =
          Enum.find(body["pairs"], &(&1 == [settings.eye_frame, settings.eye_ball])) ||
            Enum.find(body["pairs"], fn [frame, _ball] -> frame == settings.eye_frame end) ||
            Enum.find(body["pairs"], fn [_frame, ball] -> ball == settings.eye_ball end) ||
            hd(body["pairs"])

        %{settings | body_shape: body["id"], eye_frame: frame, eye_ball: ball}
    end
  end

  def regeneration_changeset(params \\ %{}) do
    {%{seed: nil}, %{seed: :integer}}
    |> Changeset.cast(params, [:seed])
    |> Changeset.validate_number(:seed,
      greater_than_or_equal_to: 0,
      less_than_or_equal_to: 4_294_967_295
    )
  end

  def generate(settings, reference, background, overrides \\ []) do
    {:ok, %{rgba: rgba}} = Parse.inspect_color(settings.background_color)

    reference =
      if settings.auto_brand and is_nil(reference) do
        dark =
          !settings.background_transparent and
            0.2126 * rgba.r + 0.7152 * rgba.g + 0.0722 * rgba.b < 127.5

        case OpenQR.WebsiteIcon.fetch(settings.payload, dark: dark) do
          :not_a_website -> {:ok, nil}
          result -> result
        end
      else
        {:ok, reference}
      end

    with {:ok, reference} <- reference do
      background_rgba =
        round(rgba.r) * 16_777_216 + round(rgba.g) * 65_536 + round(rgba.b) * 256 + 255

      options =
        settings
        |> Map.take([
          :vary_url,
          :body_shape,
          :eye_frame,
          :eye_ball
        ])
        |> Map.put(:mode, if(settings.mode == "picture", do: :picture, else: :mosaic))
        |> Map.put(
          :background_rgba,
          if(settings.background_transparent, do: 0, else: background_rgba)
        )
        |> Map.to_list()
        |> Keyword.merge(@output_options)
        |> Keyword.merge(if(reference, do: [reference: reference], else: []))
        |> Keyword.merge(if(background, do: [background: background], else: []))
        |> Keyword.merge(overrides)

      payload = if settings.ha_mr, do: settings.ha_mr_url, else: settings.payload

      scales =
        if Keyword.has_key?(overrides, :scale),
          do: [overrides[:scale]],
          else: [@output_options[:scale], 6, 3]

      Enum.reduce_while(scales, nil, fn scale, _previous ->
        case OpenQR.Engine.generate(payload, Keyword.put(options, :scale, scale)) do
          {:ok, batch} ->
            {:halt, {:ok, Map.put(batch, :source_reference, reference)}}

          {:error, "No verified layout" <> _} = error ->
            {:cont, error}

          error ->
            {:halt, error}
        end
      end)
    end
  end
end
