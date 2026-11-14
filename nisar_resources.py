import requests

class NisarResources:
    CMR_GRANULES_URL = "https://cmr.earthdata.nasa.gov/search/granules.json"
    ASF_SEARCH_URL = "https://api.daac.asf.alaska.edu/services/search/param"
    NISAR_USER_GUIDE_URL = "https://nisar-docs.asf.alaska.edu/"
    REMOTE_SENSING_INTRO_URL = "https://www.earthdata.nasa.gov/learn/earth-observation-data-basics/remote-sensing"
    SAR_INTRO_URL = "https://www.earthdata.nasa.gov/learn/earth-observation-data-basics/sar"
    ARSET_TRAININGS_URL = "https://appliedsciences.nasa.gov/get-involved/training"
    NISAR_STORYMAPS_URL = "https://nisar.jpl.nasa.gov/applications/arcgis-storymaps/"
    NISAR_WHITE_PAPERS_URL = "https://nisar.jpl.nasa.gov/applications/societal-benefit/"
    UAVSAR_POSTCARDS_URL = "https://uavsar.jpl.nasa.gov/education/postcards.html"
    TIMEOUT_S = 60
    USER_AGENT = "dancing-with-the-sars/0.1 (NASA Space Apps team)"

    def __init__(self, session: requests.Session | None = None) -> None:
        self._session = session or requests.Session()
        self._session.headers.update({"User-Agent": self.USER_AGENT})

    def _get(self, url: str, params: dict | None = None) -> requests.Response:
        response = self._session.get(url, params=params, timeout=self.TIMEOUT_S)
        response.raise_for_status()
        return response

    def _get_json(self, url: str, params: dict) -> dict:
        return self._get(url, params).json()

    def _get_html(self, url: str) -> str:
        return self._get(url).text

    def search_earthdata(
        self,
        short_name: str = "NISAR_L2_GCOV_PROVISIONAL_V1",
        bbox: tuple[float, float, float, float] | None = None,
        start: str | None = None,
        end: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        params: dict = {"short_name": short_name, "page_size": limit}
        if bbox is not None:
            params["bounding_box"] = ",".join(str(value) for value in bbox)
        if start is not None or end is not None:
            params["temporal"] = f"{start or ''},{end or ''}"
        return self._get_json(self.CMR_GRANULES_URL, params)["feed"]["entry"]

    def search_asf(
        self,
        product: str = "GCOV",
        wkt: str | None = None,
        start: str | None = None,
        end: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        params: dict = {
            "dataset": "NISAR",
            "processingLevel": product,
            "maxResults": limit,
            "output": "geojson",
        }
        if wkt is not None:
            params["intersectsWith"] = wkt
        if start is not None:
            params["start"] = start
        if end is not None:
            params["end"] = end
        return self._get_json(self.ASF_SEARCH_URL, params)["features"]

    def get_nisar_user_guide(self) -> str:
        return self._get_html(self.NISAR_USER_GUIDE_URL)

    def get_remote_sensing_intro(self) -> str:
        return self._get_html(self.REMOTE_SENSING_INTRO_URL)

    def get_sar_intro(self) -> str:
        return self._get_html(self.SAR_INTRO_URL)

    def get_arset_trainings(self) -> str:
        return self._get_html(self.ARSET_TRAININGS_URL)

    def get_nisar_storymaps(self) -> str:
        return self._get_html(self.NISAR_STORYMAPS_URL)

    def get_nisar_white_papers(self) -> str:
        return self._get_html(self.NISAR_WHITE_PAPERS_URL)

    def get_uavsar_postcards(self) -> str:
        return self._get_html(self.UAVSAR_POSTCARDS_URL)
