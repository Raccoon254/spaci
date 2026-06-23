# Spaci developer tasks.

.PHONY: release dev dist pack

# Cut a release. Add an entry to the top of changelog.json first, then run this.
# It syncs package.json, commits, tags v<version> and pushes, which triggers the
# GitHub Actions release workflow (build + publish + website sync).
release:
	node scripts/release.mjs

# Run the app in development.
dev:
	npm run dev

# Build distributables locally without publishing.
dist:
	npx electron-builder --publish never

pack:
	npm run pack
