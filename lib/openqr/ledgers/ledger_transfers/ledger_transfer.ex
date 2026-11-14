defmodule OpenQR.Ledger.Transfer do
  use Ash.Resource,
    domain: OpenQR.Ledgers.LedgerService,
    data_layer: AshPostgres.DataLayer,
    extensions: [AshDoubleEntry.Transfer, AshEvents.Events, AshPaperTrail.Resource]

  transfer do
    account_resource OpenQR.Ledger.Account
    balance_resource OpenQR.Ledger.Balance
  end

  postgres do
    table "ledger_transfers"
    repo OpenQR.Repo
  end

  events do
    event_log OpenQR.Events.Event
  end

  paper_trail do
    primary_key_type :uuid_v7
    change_tracking_mode :snapshot
    store_action_name? true
    operation_id_field :operation_id
    belongs_to_actor :actor, OpenQR.Accounts.User, domain: OpenQR.Users.UserService
    metadata :actor_name, :string
    metadata :restored_from_version_id, :uuid
    version_extensions authorizers: [Ash.Policy.Authorizer]
    mixin OpenQR.CoreUtils.Resource.AuditLog.Version
  end

  actions do
    defaults [:read]

    create :transfer do
      accept [:amount, :timestamp, :from_account_id, :to_account_id]
    end
  end

  attributes do
    attribute :id, AshDoubleEntry.ULID do
      primary_key? true
      allow_nil? false
      default &AshDoubleEntry.ULID.generate/0
    end

    attribute :amount, :money do
      allow_nil? false
    end

    timestamps()
  end

  relationships do
    belongs_to :from_account, OpenQR.Ledger.Account do
      attribute_writable? true
    end

    belongs_to :to_account, OpenQR.Ledger.Account do
      attribute_writable? true
    end

    has_many :balances, OpenQR.Ledger.Balance
  end
end
