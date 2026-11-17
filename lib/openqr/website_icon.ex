defmodule OpenQR.WebsiteIcon do
  @moduledoc false

  @failure "Could not load a website icon. Upload a reference image or disable website icon lookup."
  @request_timeout 5_000
  @lookup_timeout 20_000

  def fetch(payload, options \\ []) do
    case detect_website(payload) do
      nil ->
        :not_a_website

      website ->
        origin = %{website | path: "/", query: nil, fragment: nil}
        deadline = System.monotonic_time(:millisecond) + @lookup_timeout

        {html, homepage} =
          case fetch_resource(origin, 1_048_576, 3, deadline) do
            {:ok, %{status: status, body: html}, homepage} when status in 200..299 ->
              {html, homepage}

            _ ->
              {"", origin}
          end

        html
        |> discover_icons(homepage, options)
        |> Enum.reduce_while({:error, @failure}, fn icon, result ->
          case fetch_resource(icon, 2_097_152, 3, deadline) do
            {:ok, %{status: status, body: body}, _} when status in 200..299 ->
              case body do
                <<137, 80, 78, 71, 13, 10, 26, 10, _::binary>> -> {:halt, {:ok, body}}
                <<255, 216, 255, _::binary>> -> {:halt, {:ok, body}}
                <<"GIF87a", _::binary>> -> {:halt, {:ok, body}}
                <<"GIF89a", _::binary>> -> {:halt, {:ok, body}}
                <<"RIFF", _::binary-size(4), "WEBP", _::binary>> -> {:halt, {:ok, body}}
                <<0, 0, 1, 0, _::binary>> -> {:halt, {:ok, body}}
                _ -> {:cont, result}
              end

            _ ->
              {:cont, result}
          end
        end)
    end
  end

  def detect_website(payload) when is_binary(payload) do
    explicit = Regex.match?(~r/^[a-z][a-z0-9+.-]*:\/\//i, payload)
    candidate = if explicit, do: payload, else: "https://" <> payload

    candidate =
      case Regex.named_captures(
             ~r/\A(?<prefix>[a-z][a-z0-9+.-]*:\/\/)(?<host>[^\/?#:\[\]@]+)(?<port>:[0-9]+)?(?<tail>[\/?#].*)?\z/iu,
             candidate
           ) do
        %{} = parts ->
          try do
            hostname =
              parts["host"]
              |> String.to_charlist()
              |> :idna.encode(uts46: true, std3_rules: true)
              |> List.to_string()

            parts["prefix"] <> hostname <> parts["port"] <> parts["tail"]
          catch
            :exit, _ -> candidate
          end

        nil ->
          candidate
      end

    with false <- Regex.match?(~r/[\s\p{C}\\<>"{}|^`]/u, payload),
         false <- Regex.match?(~r/%(?![0-9a-f]{2})/i, payload),
         {:ok, uri} <- URI.new(candidate),
         true <- uri.scheme in ["http", "https"],
         true <- is_binary(uri.host) and uri.host != "",
         nil <- uri.userinfo,
         true <- uri.port in 1..65_535 do
      case :inet.parse_strict_address(String.to_charlist(uri.host)) do
        {:ok, _address} when explicit ->
          uri

        {:ok, _address} ->
          nil

        {:error, _reason} ->
          hostname = String.downcase(String.trim_trailing(uri.host, "."))
          labels = String.split(hostname, ".")

          if byte_size(hostname) <= 253 and length(labels) > 1 and
               Regex.match?(~r/^(?:[a-z]+|xn--[a-z0-9-]+)$/, List.last(labels)) and
               Enum.all?(labels, &Regex.match?(~r/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, &1)) do
            %{uri | host: hostname, authority: nil}
          end
      end
    else
      _ -> nil
    end
  end

  def discover_icons(html, homepage, options \\ []) do
    {:ok, document} = Floki.parse_document(html)

    base =
      document
      |> Floki.find("base[href]")
      |> Enum.find_value(homepage, fn element ->
        with [href] <- Floki.attribute(element, "href"),
             {:ok, relative} <- URI.new(href) do
          URI.merge(homepage, relative)
        else
          _ -> nil
        end
      end)

    dark = Keyword.get(options, :dark, false)

    icons =
      document
      |> Floki.find("link[href]")
      |> Enum.flat_map(fn {_, attributes, _} ->
        attributes = Map.new(attributes)
        relations = attributes |> Map.get("rel", "") |> String.downcase() |> String.split()

        media =
          attributes |> Map.get("media", "") |> String.downcase() |> String.replace(~r/\s/, "")

        dark_variant = String.contains?(media, "(prefers-color-scheme:dark)")
        light_variant = String.contains?(media, "(prefers-color-scheme:light)")
        themed = dark_variant != light_variant

        with true <-
               Enum.any?(
                 relations,
                 &(&1 in ["icon", "apple-touch-icon", "apple-touch-icon-precomposed"])
               ),
             true <- not themed or dark_variant == dark,
             false <- String.contains?(String.downcase(Map.get(attributes, "type", "")), "svg"),
             {:ok, relative} <- URI.new(attributes["href"]),
             icon <- URI.merge(base, relative),
             true <- icon.scheme in ["http", "https"],
             false <- String.ends_with?(String.downcase(icon.path || ""), ".svg") do
          area =
            attributes
            |> Map.get("sizes", "")
            |> String.downcase()
            |> String.split()
            |> Enum.map(fn size ->
              case String.split(size, "x") do
                [width, height] ->
                  case {Integer.parse(width), Integer.parse(height)} do
                    {{width, ""}, {height, ""}} when width > 0 and height > 0 -> width * height
                    _ -> 0
                  end

                _ ->
                  0
              end
            end)
            |> Enum.max(fn -> 0 end)

          [{icon, {themed, area, "apple-touch-icon" in relations}}]
        else
          _ -> []
        end
      end)
      |> Enum.sort_by(&elem(&1, 1), :desc)
      |> Enum.map(&elem(&1, 0))
      |> Enum.uniq_by(&URI.to_string/1)
      |> Enum.take(4)

    Enum.uniq_by(
      icons ++ [%{homepage | path: "/favicon.ico", query: nil, fragment: nil}],
      &URI.to_string/1
    )
  end

  defp fetch_resource(uri, limit, redirects, deadline) do
    with %URI{} = uri <- detect_website(URI.to_string(uri)),
         {:ok, address} <- public_destination(uri.host, deadline),
         timeout when timeout > 0 <-
           min(@request_timeout, deadline - System.monotonic_time(:millisecond)),
         scheme <- if(uri.scheme == "https", do: :https, else: :http),
         {:ok, connection} <-
           Mint.HTTP.connect(scheme, address, uri.port,
             mode: :passive,
             protocols: [:http1],
             hostname: uri.host,
             transport_opts: [timeout: timeout, send_timeout: timeout, send_timeout_close: true]
           ) do
      response =
        try do
          host = if String.contains?(uri.host, ":"), do: "[#{uri.host}]", else: uri.host

          host =
            if uri.port == URI.default_port(uri.scheme), do: host, else: "#{host}:#{uri.port}"

          target = (uri.path || "/") <> if(uri.query, do: "?" <> uri.query, else: "")

          headers = [
            {"host", host},
            {"user-agent", "Mozilla/5.0"},
            {"accept", "text/html,image/*;q=0.9,*/*;q=0.8"},
            {"accept-encoding", "identity"}
          ]

          case Mint.HTTP.request(connection, "GET", target, headers, nil) do
            {:ok, connection, reference} ->
              receive_resource(
                connection,
                reference,
                limit,
                min(deadline, System.monotonic_time(:millisecond) + @request_timeout),
                %{status: nil, headers: [], body: [], size: 0}
              )

            {:error, _, reason} ->
              {:error, reason}
          end
        after
          Mint.HTTP.close(connection)
        end

      case response do
        {:ok, %{status: status, headers: headers}}
        when status in [301, 302, 303, 307, 308] and redirects > 0 ->
          with {_, location} <- List.keyfind(headers, "location", 0),
               {:ok, relative} <- URI.new(location) do
            fetch_resource(URI.merge(uri, relative), limit, redirects - 1, deadline)
          else
            _ -> {:error, :invalid_redirect}
          end

        {:ok, %{status: status}} when status in [301, 302, 303, 307, 308] ->
          {:error, :too_many_redirects}

        {:ok, response} ->
          {:ok, response, uri}

        {:error, reason} ->
          {:error, reason}
      end
    else
      _ -> {:error, :unavailable_destination}
    end
  end

  defp receive_resource(connection, reference, limit, deadline, response) do
    timeout = deadline - System.monotonic_time(:millisecond)

    if timeout > 0 do
      case Mint.HTTP.recv(connection, 0, timeout) do
        {:ok, connection, events} ->
          events
          |> Enum.reduce_while({:cont, response}, fn
            {:status, ^reference, status}, {_, response} ->
              {:cont, {:cont, %{response | status: status}}}

            {:headers, ^reference, headers}, {_, response} ->
              {:cont, {:cont, %{response | headers: response.headers ++ headers}}}

            {:data, ^reference, data}, {_, response} ->
              if response.size + byte_size(data) <= limit do
                {:cont,
                 {:cont,
                  %{
                    response
                    | body: [data | response.body],
                      size: response.size + byte_size(data)
                  }}}
              else
                {:halt, {:error, :response_too_large}}
              end

            {:done, ^reference}, {_, response} ->
              {:halt,
               {:ok, %{response | body: response.body |> Enum.reverse() |> IO.iodata_to_binary()}}}

            {:error, ^reference, reason}, _ ->
              {:halt, {:error, reason}}

            _, response ->
              {:cont, response}
          end)
          |> case do
            {:cont, response} ->
              receive_resource(connection, reference, limit, deadline, response)

            result ->
              result
          end

        {:error, _, reason, _} ->
          {:error, reason}
      end
    else
      {:error, :timeout}
    end
  end

  defp public_destination(hostname, deadline) do
    addresses =
      case :inet.parse_strict_address(String.to_charlist(hostname)) do
        {:ok, address} ->
          [address]

        {:error, _} ->
          Enum.flat_map([:inet, :inet6], fn family ->
            timeout = min(2_000, deadline - System.monotonic_time(:millisecond))

            if timeout > 0 do
              case :inet.getaddrs(String.to_charlist(hostname), family, timeout) do
                {:ok, addresses} -> addresses
                {:error, _} -> []
              end
            else
              []
            end
          end)
      end

    if addresses != [] and Enum.all?(addresses, &public_address?/1) do
      {:ok, hd(addresses)}
    else
      {:error, :private_or_unknown_destination}
    end
  end

  defp public_address?({a, b, c, _}) do
    a not in [0, 10, 127] and a < 224 and
      not (a == 100 and b in 64..127) and
      not (a == 169 and b == 254) and
      not (a == 172 and b in 16..31) and
      not (a == 192 and (b == 168 or (b == 0 and c in [0, 2]) or (b == 88 and c == 99))) and
      not (a == 198 and (b in 18..19 or (b == 51 and c == 100))) and
      not (a == 203 and b == 0 and c == 113)
  end

  defp public_address?({a, b, _, _, _, _, _, _}) do
    a in 0x2000..0x3FFE and a != 0x2002 and
      not (a == 0x2001 and (b < 0x200 or b == 0xDB8))
  end
end
