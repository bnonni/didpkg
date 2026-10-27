// validate-npm-package-name 8.0.0 ships no types. The tests use only this part of the API.
declare module 'validate-npm-package-name' {
  export default function validate(name: string): {
    validForNewPackages: boolean;
    validForOldPackages: boolean;
    warnings?: string[];
    errors?: string[];
  };
}
