defmodule OpenQR.EngineTest do
  use ExUnit.Case, async: true

  test "generates verified QR output through the native engine" do
    payload = "https://example.com"

    assert {:ok, %{results: [result], seed: 42}} =
             OpenQR.Engine.generate(payload, version: 3, seed: 42)

    assert result.payload == payload
    assert result.total_frames > 0
    assert result.verified_frames == result.total_frames
    assert <<137, 80, 78, 71, 13, 10, 26, 10, _::binary>> = result.image
    assert result.svg =~ "<svg"
  end
end
