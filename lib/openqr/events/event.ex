defmodule OpenQR.Events.Event do
  use Ash.Resource,
    otp_app: :openqr,
    domain: OpenQR.Events.EventService,
    data_layer: AshPostgres.DataLayer,
    authorizers: [Ash.Policy.Authorizer],
    extensions: [AshEvents.EventLog]

  postgres do
    table "events"
    repo OpenQR.Repo
  end

  event_log do
    clear_records_for_replay OpenQR.Events.ClearAllRecords
    primary_key_type Ash.Type.UUIDv7
    record_id_type :string
    persist_actor_primary_key :user_id, OpenQR.Accounts.User
  end

  actions do
    defaults [:read]
  end

  policies do
    bypass actor_attribute_equals(:system, true) do
      authorize_if always()
    end
  end
end
