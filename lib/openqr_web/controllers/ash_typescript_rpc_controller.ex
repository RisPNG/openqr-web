defmodule OpenQRWeb.AshTypescriptRpcController do
  use OpenQRWeb, :controller

  def run(conn, params) do
    result = AshTypescript.Rpc.run_action(:openqr, conn, params)
    json(conn, result)
  end

  def validate(conn, params) do
    result = AshTypescript.Rpc.validate_action(:openqr, conn, params)
    json(conn, result)
  end
end
