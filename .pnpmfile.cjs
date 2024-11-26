function readPackage(pkg, _) {
  if (pkg.name === "@cf-eventhub/web-console") {
    pkg.dependencies = {
      ...pkg.dependencies,
      "cf-eventhub": "workspace:../cf-eventhub",
    };
  }
  if (pkg.name === "@cf-eventhub/pulumi") {
    pkg.dependencies = {
      ...pkg.dependencies,
      "cf-eventhub": "workspace:../../cf-eventhub",
    };
  }

  return pkg;
}

module.exports = {
  hooks: {
    readPackage,
  },
};
