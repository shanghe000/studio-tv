package authorization

import "studio.example.invalid/maintainer/ipac-client-kit/manifest"

// ManifestDocument is a complete snapshot. Registration is an explicit release
// operation (Preview, then Submit, then IPAC administrator approval); startup
// never mutates central permissions.
func ManifestDocument(applicationCode, version string) manifest.Document {
	return manifest.Document{SchemaVersion: manifest.SchemaVersion, ApplicationCode: applicationCode, ManifestVersion: version, Capabilities: []manifest.Capability{
		{Code: TVAccess, Name: "使用 Studio TV", Description: "在已授权的项目工作空间中使用 Studio TV，查看、创建、编辑、删除本人画布作品与素材。"},
	}}
}
