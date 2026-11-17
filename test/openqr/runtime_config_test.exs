defmodule OpenQR.RuntimeConfigTest do
  use ExUnit.Case, async: false

  setup do
    names = ~w(DEFAULT_QR_DIRECTORY RELEASE_ROOT UPLOAD_DIRECTORY SECRET_KEY_BASE)
    previous = Map.new(names, &{&1, System.get_env(&1)})
    System.delete_env("DEFAULT_QR_DIRECTORY")
    System.delete_env("RELEASE_ROOT")
    System.put_env("UPLOAD_DIRECTORY", Path.expand("tmp/uploads/public"))
    System.put_env("SECRET_KEY_BASE", String.duplicate("a", 64))
    on_exit(fn -> System.put_env(previous) end)
    :ok
  end

  test "production Mix runs use the existing project cache" do
    config = Config.Reader.read!("config/runtime.exs", env: :prod)
    assert config[:openqr][:default_qr_directory] == Path.expand("var/qr_defaults")
  end

  test "a persistent cache override takes precedence over release defaults" do
    System.put_env("DEFAULT_QR_DIRECTORY", Path.expand("tmp/persistent-defaults"))
    System.put_env("RELEASE_ROOT", Path.expand("tmp/release"))
    config = Config.Reader.read!("config/runtime.exs", env: :prod)
    assert config[:openqr][:default_qr_directory] == Path.expand("tmp/persistent-defaults")
  end

  test "assembled releases retain the packaged cache default" do
    System.put_env("RELEASE_ROOT", Path.expand("tmp/release"))
    config = Config.Reader.read!("config/runtime.exs", env: :prod)

    assert config[:openqr][:default_qr_directory] ==
             Application.app_dir(:openqr, "priv/qr_defaults")
  end
end
