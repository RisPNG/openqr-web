defmodule Mix.Tasks.Qr.Prebuild do
  use Mix.Task

  @shortdoc "Prebuilds every default QR style combination"
  @requirements ["app.config"]

  @impl true
  def run(arguments) do
    {options, positional} =
      OptionParser.parse!(arguments,
        strict: [
          concurrency: :integer,
          limit: :integer,
          status: :boolean,
          directory: :string,
          catalog: :boolean,
          source_directory: :string
        ]
      )

    if positional != [], do: Mix.raise("Unexpected arguments: #{Enum.join(positional, " ")}")

    if options[:source_directory] && !options[:catalog],
      do: Mix.raise("--source-directory requires --catalog.")

    options =
      Keyword.put_new(
        options,
        :directory,
        Application.get_env(:openqr, :default_qr_directory, Path.expand("priv/qr_defaults"))
      )

    if options[:catalog] do
      unless options[:status] do
        OpenQR.DefaultQR.build_catalog(
          Keyword.put(options, :progress, fn summary ->
            if rem(summary.combinations, 100) == 0 do
              Mix.shell().info(
                "Packed #{summary.combinations} combinations: #{summary.available} available, #{summary.skipped} skipped versions"
              )
            end
          end)
        )
      end

      status = OpenQR.DefaultQR.catalog_status(options)

      Mix.shell().info(
        "Default QR catalog: #{status.id || "unpublished"}, #{status.available} available, #{status.skipped} skipped versions, #{status.bytes} compressed bytes in #{status.directory}"
      )
    else
      prebuild(options)
    end
  end

  defp prebuild(options) do
    status = OpenQR.DefaultQR.status(options)

    Mix.shell().info(
      "Default QR cache: #{status.completed}/#{status.total} combinations, #{status.bytes} bytes in #{status.directory}"
    )

    unless options[:status] do
      summary =
        OpenQR.DefaultQR.prebuild(
          Keyword.put(options, :progress, fn summary ->
            if rem(summary.completed, 10) == 0 or summary.completed == summary.selected do
              Mix.shell().info(
                "Processed #{summary.completed}/#{summary.selected} combinations: #{summary.built} built, #{summary.reused} reused, #{summary.failed} failed, #{summary.skipped_versions} skipped versions"
              )
            end
          end)
        )

      Enum.each(summary.failures, fn {reason, count} ->
        Mix.shell().error("#{count} combinations: #{reason}")
      end)

      status = OpenQR.DefaultQR.status(options)

      Mix.shell().info(
        "Default QR cache: #{status.completed}/#{status.total} combinations, #{status.bytes} bytes"
      )

      if summary.built + summary.reused != summary.completed do
        Mix.raise("Some default QR presets could not be written. Rerun the task to resume.")
      end
    end
  end
end
