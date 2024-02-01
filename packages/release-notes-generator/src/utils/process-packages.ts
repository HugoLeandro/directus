import { findWorkspacePackagesNoCheck, type Project } from '@pnpm/find-workspace-packages';
import { createPkgGraph, type PackageNode } from '@pnpm/workspace.pkgs-graph';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';
import config from '../config.js';
import type { PackageVersion } from '../types.js';
import { sortByExternalOrder } from './sort.js';

export async function processPackages(): Promise<{
	mainVersion: string;
	isPrerelease: boolean;
	prereleaseId: string | undefined;
	packageVersions: PackageVersion[];
}> {
	const workspacePackages = await findWorkspacePackagesNoCheck(process.cwd());
	const packageVersions = new Map<string, string>();
	let dependentsMap: Record<string, string[]> | undefined;

	for (const localPackage of workspacePackages) {
		const { name, version } = localPackage.manifest;

		if (!name) {
			continue;
		}

		const changelogPath = join(localPackage.dir, 'CHANGELOG.md');

		// The package has been bumped if a changelog file is generated
		// (catches packages bumped solely due to internal dependency updates from changesets too)
		if (existsSync(changelogPath)) {
			if (version) {
				let finalVersion = version;

				// Reset 'version' field in private packages (falsely increased by changesets)
				if (localPackage.manifest.private) {
					finalVersion = '0.0.0';
					localPackage.manifest.version = finalVersion;
					await localPackage.writeProjectManifest(localPackage.manifest);
				}

				packageVersions.set(name, finalVersion);
			}

			// Remove changelog files generated by changeset in favor of release notes
			unlinkSync(changelogPath);
		}
	}

	const { mainVersion, manualMainVersion, isPrerelease, prereleaseId } = getVersionInfo();

	if (manualMainVersion) {
		await bumpPackage(config.mainPackage, mainVersion, true);
	}

	for (const [trigger, target] of config.linkedPackages) {
		if (packageVersions.has(trigger) && !packageVersions.has(target)) {
			await bumpPackage(target, null, true);
		}
	}

	return {
		mainVersion,
		isPrerelease,
		prereleaseId,
		packageVersions: Array.from(packageVersions, ([name, version]) => ({
			name,
			version,
		}))
			.filter(({ name }) => ![config.mainPackage, ...Object.keys(config.untypedPackageTitles)].includes(name))
			.sort(sortByExternalOrder(config.packageOrder, 'name')),
	};

	function getVersionInfo() {
		const manualMainVersion = process.env['DIRECTUS_VERSION'];

		const mainVersion = semver.parse(manualMainVersion ?? packageVersions.get(config.mainPackage));

		if (!mainVersion) {
			throw new Error(`Main version ('${config.mainPackage}' package) is missing or invalid`);
		}

		const isPrerelease = mainVersion.prerelease.length > 0;
		let prereleaseId;

		if (isPrerelease) {
			let tag;

			try {
				const changesetPreFile = join(process.cwd(), '.changeset', 'pre.json');
				({ tag } = JSON.parse(readFileSync(changesetPreFile, 'utf8')));
			} catch {
				throw new Error(`Main version is a prerelease but changesets isn't in prerelease mode`);
			}

			prereleaseId = mainVersion.prerelease[0];

			if (typeof prereleaseId !== 'string') {
				throw new Error(`Expected a string for prerelease identifier`);
			}

			if (prereleaseId !== tag) {
				throw new Error(`Prerelease identifier of main version doesn't match tag of changesets prerelease mode`);
			}
		}

		return { mainVersion: mainVersion.version, manualMainVersion, isPrerelease, prereleaseId };
	}

	async function bumpPackage(packageName: string, version?: string | null, bumpDependents?: boolean) {
		const workspacePackage = workspacePackages.find((p) => p.manifest.name === packageName);

		if (!workspacePackage) return;

		let newVersion: string | null = null;

		if (version) {
			newVersion = version;
		} else if (workspacePackage.manifest.version) {
			newVersion = semver.inc(workspacePackage.manifest.version, isPrerelease ? 'prerelease' : 'patch', prereleaseId);
		}

		if (!newVersion) return;

		workspacePackage.manifest.version = newVersion;
		await workspacePackage.writeProjectManifest(workspacePackage.manifest);
		packageVersions.set(packageName, newVersion);

		if (bumpDependents) {
			const dependents = findDependents(packageName);

			for (const dependent of dependents) {
				if (!packageVersions.has(dependent)) await bumpPackage(dependent);
			}
		}
	}

	function getDependentsMap() {
		if (!dependentsMap) {
			const { graph } = createPkgGraph(workspacePackages);
			dependentsMap = transformGraph(graph);
		}

		return dependentsMap;
	}

	function findDependents(
		packageName: string,
		dependentsMap = getDependentsMap(),
		dependents: string[] = [],
		visited = new Set<string>()
	) {
		if (visited.has(packageName)) return dependents;
		visited.add(packageName);

		const packageDependents = dependentsMap[packageName];

		if (!packageDependents || packageDependents.length === 0) return dependents;

		for (const dependent of packageDependents) {
			if (visited.has(dependent)) continue;

			dependents.push(dependent);

			findDependents(dependent, dependentsMap, dependents, visited);
		}

		return dependents;
	}

	function transformGraph(graph: Record<string, PackageNode<Project>>) {
		const dependentsMap: Record<string, string[]> = {};

		for (const dependentNodeId of Object.keys(graph)) {
			const dependentPackage = graph[dependentNodeId];
			const dependentPackageName = dependentPackage?.package.manifest.name;

			if (!dependentPackageName) continue;

			for (const dependencyNodeId of dependentPackage.dependencies) {
				const dependencyPackage = workspacePackages.find((p) => p.dir === dependencyNodeId);
				const dependencyPackageName = dependencyPackage?.manifest.name;

				if (!dependencyPackageName) continue;

				if (!dependentsMap[dependencyPackageName]) {
					dependentsMap[dependencyPackageName] = [dependentPackageName];
				} else {
					dependentsMap[dependencyPackageName]?.push(dependentPackageName);
				}
			}
		}

		return dependentsMap;
	}
}