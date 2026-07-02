package ext

type CapabilityKind string

const (
	CapabilityCollector          CapabilityKind = "collector"
	CapabilityScraper            CapabilityKind = "scraper"
	CapabilityMetric             CapabilityKind = "metric"
	CapabilityTransform          CapabilityKind = "transform"
	CapabilitySecurity           CapabilityKind = "security"
	CapabilityCredentialProvider CapabilityKind = "credential_provider"
	CapabilityDiscovery          CapabilityKind = "discovery"
	CapabilityConfigProfile      CapabilityKind = "config_profile"
	CapabilityProtocolClient     CapabilityKind = "protocol_client"
	CapabilityCache              CapabilityKind = "cache"
	CapabilityBundle             CapabilityKind = "bundle"
)

type CapabilityInfo struct {
	Name           string            `json:"name" yaml:"name"`
	Kind           CapabilityKind    `json:"kind" yaml:"kind"`
	Version        string            `json:"version" yaml:"version"`
	Description    string            `json:"description" yaml:"description"`
	Owner          string            `json:"owner" yaml:"owner"`
	ImportPath     string            `json:"import_path" yaml:"import_path"`
	Source         string            `json:"source" yaml:"source"`
	DefaultEnabled bool              `json:"default_enabled" yaml:"default_enabled"`
	Provides       []string          `json:"provides" yaml:"provides"`
	Requires       []string          `json:"requires" yaml:"requires"`
	Metrics        []string          `json:"metrics" yaml:"metrics"`
	Config         map[string]string `json:"config" yaml:"config"`
	Compatible     CompatibleRange   `json:"compatible" yaml:"compatible"`
	Files          []string          `json:"files" yaml:"files"`
}

type CompatibleRange struct {
	Exporters  []string `json:"exporters" yaml:"exporters"`
	MinVersion string   `json:"min_version" yaml:"min_version"`
	MaxVersion string   `json:"max_version" yaml:"max_version"`
}

var capabilityRegistry []CapabilityInfo

func RegisterCapability(info CapabilityInfo) {
	capabilityRegistry = append(capabilityRegistry, info)
}

func RegisteredCapabilities() []CapabilityInfo {
	out := make([]CapabilityInfo, len(capabilityRegistry))
	copy(out, capabilityRegistry)
	return out
}

type CollectorFactory interface{}
type ScraperFactory interface{}
type SecurityMiddlewareFactory interface{}
type CredentialProviderFactory interface{}

var (
	collectorRegistry           []CollectorFactory
	scraperRegistry             []ScraperFactory
	securityMiddlewareRegistry []SecurityMiddlewareFactory
	credentialProviderRegistry []CredentialProviderFactory
)

func RegisterCollector(factory CollectorFactory) {
	collectorRegistry = append(collectorRegistry, factory)
}

func RegisterScraper(factory ScraperFactory) {
	scraperRegistry = append(scraperRegistry, factory)
}

func RegisterSecurityMiddleware(factory SecurityMiddlewareFactory) {
	securityMiddlewareRegistry = append(securityMiddlewareRegistry, factory)
}

func RegisterCredentialProvider(factory CredentialProviderFactory) {
	credentialProviderRegistry = append(credentialProviderRegistry, factory)
}
