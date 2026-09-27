// Local type stub for axios, mapped via tsconfig "paths".
export interface AxiosResponse<T = any> {
  data: T;
  status: number;
}

export interface AxiosRequestConfig {
  headers?: Record<string, string>;
  timeout?: number;
}

declare const axios: {
  post<T = any>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
  get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>;
};
export default axios;
