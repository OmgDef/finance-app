import Constants from 'expo-constants';
import { appVariants } from './app-variants';

export const appVariant = Constants.expoConfig?.extra?.appVariant === 'b' ? 'b' : 'a';
export const appBrand = appVariants[appVariant];
export const isComaBank = appVariant === 'b';
