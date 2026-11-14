defmodule OpenQR.AccessControl.RolePerm do
  use Ash.Resource,
    domain: OpenQR.AccessControl.AccessControlService,
    data_layer: AshPostgres.DataLayer,
    authorizers: [Ash.Policy.Authorizer],
    extensions: [AshEvents.Events, AshPaperTrail.Resource]

  postgres do
    table "role_perms"
    repo OpenQR.Repo

    references do
      reference :role, on_delete: :delete, on_update: :update, index?: true
      reference :sitenav, on_delete: :restrict, on_update: :update, index?: true
    end
  end

  events do
    event_log OpenQR.Events.Event
  end

  paper_trail do
    primary_key_type :uuid_v7
    reference_source? false
    change_tracking_mode :snapshot
    store_action_name? true
    attributes_as_attributes [:roles_code, :sitenav_code]
    operation_id_field :operation_id
    belongs_to_actor :actor, OpenQR.Accounts.User, domain: OpenQR.Users.UserService
    metadata :actor_name, :string
    metadata :restored_from_version_id, :uuid
    version_extensions authorizers: [Ash.Policy.Authorizer]
    mixin OpenQR.CoreUtils.Resource.AuditLog.Version
  end

  use OpenQR.AccessControl.ResourcePolicies, path: "/dashboard/admin/roles"

  code_interface do
    define? false
    define :list_role_permissions, action: :read
  end

  actions do
    defaults [:read, :destroy]

    create :create do
      primary? true
      accept [:sitenav_code, :roles_code, :level]
    end

    update :update do
      primary? true
      accept [:sitenav_code, :roles_code, :level]
    end
  end

  policies do
    policy action_type([:create, :update, :destroy]) do
      authorize_if {OpenQR.AccessControl.ResourcePolicy,
                    paths: ["/dashboard/admin/roles"], capability: :su}
    end
  end

  validations do
    validate one_of(
               :level,
               Enum.map(OpenQR.AccessControl.Permissions.level_options(), &elem(&1, 1))
             )
  end

  attributes do
    uuid_v7_primary_key :id

    attribute :level, :integer do
      allow_nil? false
    end

    timestamps()
  end

  relationships do
    belongs_to :sitenav, OpenQR.AccessControl.Sitenav do
      source_attribute :sitenav_code
      destination_attribute :code
      attribute_type :string
      allow_nil? false
      attribute_writable? true
    end

    belongs_to :role, OpenQR.AccessControl.Role do
      source_attribute :roles_code
      destination_attribute :code
      attribute_type :string
      allow_nil? false
      attribute_writable? true
    end
  end

  identities do
    identity :unique_role_sitenav, [:roles_code, :sitenav_code]
  end
end
